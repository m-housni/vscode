/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ============================================================================
// IMPORTS
// ============================================================================

// Node.js core modules
import * as path from 'node:path';
import * as fs from 'original-fs';  // Uses 'original-fs' to bypass ASAR packaging
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';

// VS Code bootstrap modules - these set up the environment before main code loads
import { configurePortable } from './bootstrap-node.js';
import { bootstrapESM } from './bootstrap-esm.js';

// Electron modules - the framework VS Code is built on
import { app, protocol, crashReporter, Menu, contentTracing } from 'electron';

// Third-party modules
import minimist from 'minimist';  // Command-line argument parser

// VS Code internal modules
import { product } from './bootstrap-meta.js';
import { parse } from './vs/base/common/jsonc.js';  // JSON with comments parser
import { getUserDataPath } from './vs/platform/environment/node/userDataPath.js';
import * as perf from './vs/base/common/performance.js';
import { resolveNLSConfiguration } from './vs/base/node/nls.js';  // NLS = National Language Support (i18n)
import { getUNCHost, addUNCHostToAllowlist } from './vs/base/node/unc.js';  // UNC = Universal Naming Convention (Windows network paths)
import { INLSConfiguration } from './vs/nls.js';
import { NativeParsedArgs } from './vs/platform/environment/common/argv.js';

// ============================================================================
// PERFORMANCE TRACKING - Mark the very start of main process
// ============================================================================

// Mark when the main process started executing
perf.mark('code/didStartMain');

// Mark when we started loading the main bundle
// When VS Code is built for production, all code is bundled into a single file
// We use performance.timeOrigin to get the absolute start time of the process
perf.mark('code/willLoadMainBundle', {
	// When built, the main bundle is a single JS file with all
	// dependencies inlined. As such, we mark `willLoadMainBundle`
	// as the start of the main bundle loading process.
	startTime: Math.floor(performance.timeOrigin)
});

// Mark that the main bundle has been loaded into memory
perf.mark('code/didLoadMainBundle');

// ============================================================================
// PORTABLE MODE CONFIGURATION
// ============================================================================

// Enable portable support - allows VS Code to run from a USB drive
// Portable mode keeps all user data in a single folder alongside the executable
const portable = configurePortable(product);

// ============================================================================
// COMMAND LINE ARGUMENT PARSING
// ============================================================================

// Parse all command-line arguments passed to VS Code
// Examples: --user-data-dir, --locale, --disable-gpu, etc.
const args = parseCLIArgs();

// ============================================================================
// CONFIGURE STATIC COMMAND LINE SWITCHES
// ============================================================================

// Load configuration from argv.json file (persistent command-line switches)
// This allows users to set permanent flags without typing them every time
const argvConfig = configureCommandlineSwitchesSync(args);

// ============================================================================
// SANDBOX CONFIGURATION
// ============================================================================

// Enable sandbox globally unless explicitly disabled
// The sandbox is a security feature that isolates renderer processes
// 
// Sandbox is ENABLED when:
// - args['sandbox'] is true (default)
// - AND neither --disable-chromium-sandbox flag is present
// - AND argv.json doesn't contain disable-chromium-sandbox: true
if (args['sandbox'] &&
	!args['disable-chromium-sandbox'] &&
	!argvConfig['disable-chromium-sandbox']) {
	app.enableSandbox();
} 
// Special case: if --no-sandbox is used but --disable-gpu-sandbox is not,
// we need to also disable GPU sandbox for consistency
else if (app.commandLine.hasSwitch('no-sandbox') &&
	!app.commandLine.hasSwitch('disable-gpu-sandbox')) {
	// Disable GPU sandbox whenever --no-sandbox is used.
	app.commandLine.appendSwitch('disable-gpu-sandbox');
} 
// Otherwise, explicitly disable both sandboxes
else {
	app.commandLine.appendSwitch('no-sandbox');
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// ============================================================================
// USER DATA PATH SETUP
// ============================================================================

// Set userData path BEFORE app 'ready' event fires
// This is where VS Code stores all user-specific data:
// - Settings (settings.json)
// - Extensions
// - Workspaces
// - Logs
// - Cache
const userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');

// On Windows, if the user data path is a UNC path (network location),
// we need to add it to the allowlist to enable access
if (process.platform === 'win32') {
	const userDataUNCHost = getUNCHost(userDataPath);
	if (userDataUNCHost) {
		addUNCHostToAllowlist(userDataUNCHost); // enables to use UNC paths in userDataPath
	}
}

// Tell Electron where to store user data
app.setPath('userData', userDataPath);

// ============================================================================
// CODE CACHE PATH RESOLUTION
// ============================================================================

// Resolve code cache path - this is where V8 stores compiled JavaScript
// Code caching significantly improves startup performance on subsequent launches
// Returns undefined if caching is disabled or not applicable
const codeCachePath = getCodeCachePath();

// ============================================================================
// APPLICATION MENU CONFIGURATION
// ============================================================================

// Disable default menu (https://github.com/electron/electron/issues/35512)
// VS Code implements its own custom menu system
Menu.setApplicationMenu(null);

// ============================================================================
// CRASH REPORTER CONFIGURATION
// ============================================================================

// Track when we start configuring the crash reporter
perf.mark('code/willStartCrashReporter');

// Configure crash reporter if:
// 1. A custom crash-reporter-directory is specified (for local crash dumps), OR
// 2. enable-crash-reporter is true in argv.json AND --disable-crash-reporter flag is NOT present
//
// If a crash-reporter-directory is specified we store the crash reports
// in the specified directory and don't upload them to the crash server.
//
// Appcenter crash reporting is enabled if
// * enable-crash-reporter runtime argument is set to 'true'
// * --disable-crash-reporter command line parameter is not set
//
// Disable crash reporting in all other cases.
if (args['crash-reporter-directory'] || (argvConfig['enable-crash-reporter'] && !args['disable-crash-reporter'])) {
	configureCrashReporter();
}

// Track when crash reporter configuration is complete
perf.mark('code/didStartCrashReporter');

// ============================================================================
// PORTABLE MODE - LOGS PATH SETUP
// ============================================================================

// Set logs path before app 'ready' event if running portable
// This ensures that no 'logs' folder is created on disk at a
// location outside of the portable directory
// (https://github.com/microsoft/vscode/issues/56651)
if (portable.isPortable) {
	app.setAppLogsPath(path.join(userDataPath, 'logs'));
}

// ============================================================================
// CUSTOM PROTOCOL REGISTRATION
// ============================================================================

// Register custom schemes with privileges
// These are custom URL schemes that VS Code uses internally
// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
	{
		// vscode-webview:// - Used for webview content (extensions' custom UI)
		scheme: 'vscode-webview',
		privileges: { 
			standard: true,        // Treats it like http/https
			secure: true,          // Treats it as secure origin (like https)
			supportFetchAPI: true, // Allows fetch() API
			corsEnabled: true,     // Enables CORS
			allowServiceWorkers: true, // Allows service workers
			codeCache: true        // Enables V8 code caching
		}
	},
	{
		// vscode-file:// - Used for accessing local files securely
		scheme: 'vscode-file',
		privileges: { 
			secure: true, 
			standard: true, 
			supportFetchAPI: true, 
			corsEnabled: true, 
			codeCache: true 
		}
	}
]);

// ============================================================================
// GLOBAL APP LISTENERS
// ============================================================================

// Register global event listeners (for macOS file/URL handling)
registerListeners();

// ============================================================================
// NLS (NATIONAL LANGUAGE SUPPORT) CONFIGURATION
// ============================================================================

/**
 * We can resolve the NLS configuration early if it is defined
 * in argv.json before `app.ready` event. Otherwise we can only
 * resolve NLS after `app.ready` event to resolve the OS locale.
 */
let nlsConfigurationPromise: Promise<INLSConfiguration> | undefined = undefined;

// Get the OS locale using Electron's API
// Use the most preferred OS language for language recommendation.
// The API might return an empty array on Linux, such as when
// the 'C' locale is the user's only configured locale.
// No matter the OS, if the array is empty, default back to 'en'.
const osLocale = processZhLocale((app.getPreferredSystemLanguages()?.[0] ?? 'en').toLowerCase());

// Check if user has defined a locale in command-line args or argv.json
const userLocale = getUserDefinedLocale(argvConfig);

// If user defined a locale, start resolving NLS configuration early (before app ready)
if (userLocale) {
	nlsConfigurationPromise = resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: product.commit,      // Used to find the right language pack version
		userDataPath,
		nlsMetadataPath: import.meta.dirname  // Where language pack files are located
	});
}

// ============================================================================
// ELECTRON LOCALE CONFIGURATION
// ============================================================================

// Pass in the locale to Electron so that the
// Windows Control Overlay is rendered correctly on Windows.
// For now, don't pass in the locale on macOS due to
// https://github.com/microsoft/vscode/issues/167543.
// If the locale is `qps-ploc`, the Microsoft
// Pseudo Language Language Pack is being used.
// In that case, use `en` as the Electron locale.
if (process.platform === 'win32' || process.platform === 'linux') {
	// Use 'en' for pseudo-locale, otherwise use the user's locale
	const electronLocale = (!userLocale || userLocale === 'qps-ploc') ? 'en' : userLocale;
	app.commandLine.appendSwitch('lang', electronLocale);
}

// ============================================================================
// APP READY EVENT - MAIN ENTRY POINT
// ============================================================================

// Load our code once Electron is ready
app.once('ready', function () {
	// If --trace flag is present, start Chrome tracing for performance debugging
	if (args['trace']) {
		let traceOptions: Electron.TraceConfig | Electron.TraceCategoriesAndOptions;
		
		// Special configuration for memory profiling
		if (args['trace-memory-infra']) {
			const customCategories = args['trace-category-filter']?.split(',') || [];
			// Add memory-related trace categories
			customCategories.push('disabled-by-default-memory-infra', 'disabled-by-default-memory-infra.v8.code_stats');
			traceOptions = {
				included_categories: customCategories,
				excluded_categories: ['*'],
				memory_dump_config: {
					allowed_dump_modes: ['light', 'detailed'],
					triggers: [
						{
							type: 'periodic_interval',
							mode: 'detailed',
							min_time_between_dumps_ms: 10000  // Detailed dump every 10 seconds
						},
						{
							type: 'periodic_interval',
							mode: 'light',
							min_time_between_dumps_ms: 1000   // Light dump every second
						}
					]
				}
			};
		} 
		// Standard trace configuration
		else {
			traceOptions = {
				categoryFilter: args['trace-category-filter'] || '*',  // Which categories to trace
				traceOptions: args['trace-options'] || 'record-until-full,enable-sampling'
			};
		}

		// Start recording traces, then proceed to onReady
		contentTracing.startRecording(traceOptions).finally(() => onReady());
	} else {
		// No tracing requested, proceed directly to onReady
		onReady();
	}
});

// ============================================================================
// ON READY HANDLER
// ============================================================================

/**
 * Called once Electron is ready and optional tracing has started
 * This is where the real startup begins
 */
async function onReady() {
	// Mark that the app is ready
	perf.mark('code/mainAppReady');

	try {
		// Run two tasks in parallel:
		// 1. Create code cache directory (for V8 compiled code)
		// 2. Resolve NLS configuration (language/locale settings)
		const [, nlsConfig] = await Promise.all([
			mkdirpIgnoreError(codeCachePath),
			resolveNlsConfiguration()
		]);

		// Start the main VS Code application
		await startup(codeCachePath, nlsConfig);
	} catch (error) {
		console.error(error);
	}
}

// ============================================================================
// MAIN STARTUP ROUTINE
// ============================================================================

/**
 * Main startup routine - this is where VS Code actually starts loading
 * 
 * @param codeCachePath - Path to V8 code cache directory
 * @param nlsConfig - Resolved language/locale configuration
 */
async function startup(codeCachePath: string | undefined, nlsConfig: INLSConfiguration): Promise<void> {
	// Store NLS configuration in environment variable so child processes can access it
	process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
	
	// Store code cache path in environment variable
	process.env['VSCODE_CODE_CACHE_PATH'] = codeCachePath || '';

	// Bootstrap ESM (ECMAScript Modules) loader
	// This sets up the module system for loading VS Code's modern JavaScript modules
	await bootstrapESM();

	// Load the actual VS Code main process code
	// This is where the real application logic lives
	await import('./vs/code/electron-main/main.js');
	
	// Mark that the main bundle has finished running
	perf.mark('code/didRunMainBundle');
}

// ============================================================================
// COMMAND LINE SWITCHES CONFIGURATION
// ============================================================================

/**
 * Configures Electron and main process command-line switches
 * Reads from argv.json and applies appropriate switches
 */
function configureCommandlineSwitchesSync(cliArgs: NativeParsedArgs) {
	// List of Electron switches that we allow users to configure
	const SUPPORTED_ELECTRON_SWITCHES = [

		// alias from us for --disable-gpu
		'disable-hardware-acceleration',

		// override for the color profile to use
		'force-color-profile',

		// disable LCD font rendering, a Chromium flag
		'disable-lcd-text',

		// bypass any specified proxy for the given semi-colon-separated list of hosts
		'proxy-bypass-list',

		// Enable remote debugging on specified port
		'remote-debugging-port'
	];

	// Linux-specific switches
	if (process.platform === 'linux') {

		// Force enable screen readers on Linux via this flag
		SUPPORTED_ELECTRON_SWITCHES.push('force-renderer-accessibility');

		// override which password-store is used on Linux (gnome-libsecret, kwallet, etc.)
		SUPPORTED_ELECTRON_SWITCHES.push('password-store');
	}

	// List of switches that affect the main process (not Electron/Chromium)
	const SUPPORTED_MAIN_PROCESS_SWITCHES = [

		// Persistently enable proposed api via argv.json: https://github.com/microsoft/vscode/issues/99775
		'enable-proposed-api',

		// Log level to use. Default is 'info'. Allowed values are 'error', 'warn', 'info', 'debug', 'trace', 'off'.
		'log-level',

		// Use an in-memory storage for secrets (instead of OS keychain)
		'use-inmemory-secretstorage',

		// Enables display tracking to restore maximized windows under RDP: https://github.com/electron/electron/issues/47016
		'enable-rdp-display-tracking',
	];

	// Read argv.json configuration file
	const argvConfig = readArgvConfigSync();

	// Process each key in argv.json
	Object.keys(argvConfig).forEach(argvKey => {
		const argvValue = argvConfig[argvKey];

		// ====================================================================
		// Handle Electron switches
		// ====================================================================
		if (SUPPORTED_ELECTRON_SWITCHES.indexOf(argvKey) !== -1) {
			// Boolean flags (e.g., "disable-hardware-acceleration": true)
			if (argvValue === true || argvValue === 'true') {
				if (argvKey === 'disable-hardware-acceleration') {
					// Hardware acceleration requires special API call
					app.disableHardwareAcceleration(); // needs to be called explicitly
				} else {
					// Other boolean flags just need the switch added
					app.commandLine.appendSwitch(argvKey);
				}
			} 
			// String value flags (e.g., "force-color-profile": "srgb")
			else if (typeof argvValue === 'string' && argvValue) {
				if (argvKey === 'password-store') {
					// Password store migration logic
					// TODO@TylerLeonhardt: Remove this migration in 3 months
					let migratedArgvValue = argvValue;
					// Migrate old password store names to new ones
					if (argvValue === 'gnome' || argvValue === 'gnome-keyring') {
						migratedArgvValue = 'gnome-libsecret';
					}
					app.commandLine.appendSwitch(argvKey, migratedArgvValue);
				} else {
					app.commandLine.appendSwitch(argvKey, argvValue);
				}
			}
		}

		// ====================================================================
		// Handle main process switches
		// ====================================================================
		else if (SUPPORTED_MAIN_PROCESS_SWITCHES.indexOf(argvKey) !== -1) {
			switch (argvKey) {
				case 'enable-proposed-api':
					// Proposed APIs are experimental extension APIs
					// Value should be an array of extension IDs
					if (Array.isArray(argvValue)) {
						argvValue.forEach(id => id && typeof id === 'string' && process.argv.push('--enable-proposed-api', id));
					} else {
						console.error(`Unexpected value for \`enable-proposed-api\` in argv.json. Expected array of extension ids.`);
					}
					break;

				case 'log-level':
					// Can be a single string or array of strings
					if (typeof argvValue === 'string') {
						process.argv.push('--log', argvValue);
					} else if (Array.isArray(argvValue)) {
						for (const value of argvValue) {
							process.argv.push('--log', value);
						}
					}
					break;

				case 'use-inmemory-secretstorage':
					// Use in-memory secret storage instead of OS keychain
					if (argvValue) {
						process.argv.push('--use-inmemory-secretstorage');
					}
					break;

				case 'enable-rdp-display-tracking':
					// Enable RDP display tracking for better window restoration
					if (argvValue) {
						process.argv.push('--enable-rdp-display-tracking');
					}
					break;
			}
		}
	});

	// ========================================================================
	// Configure Chromium feature flags
	// ========================================================================
	
	// Following features are enabled from the runtime:
	// `NetAdapterMaxBufSizeFeature` - Specify the max buffer size for NetToMojoPendingBuffer, refs https://github.com/microsoft/vscode/issues/268800
	// `DocumentPolicyIncludeJSCallStacksInCrashReports` - https://www.electronjs.org/docs/latest/api/web-frame-main#framecollectjavascriptcallstack-experimental
	// `EarlyEstablishGpuChannel` - Refs https://issues.chromium.org/issues/40208065
	// `EstablishGpuChannelAsync` - Refs https://issues.chromium.org/issues/40208065
	const featuresToEnable =
		`NetAdapterMaxBufSizeFeature:NetAdapterMaxBufSize/8192,DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync,${app.commandLine.getSwitchValue('enable-features')}`;
	app.commandLine.appendSwitch('enable-features', featuresToEnable);

	// Following features are disabled from the runtime:
	// `CalculateNativeWinOcclusion` - Disable native window occlusion tracker (https://groups.google.com/a/chromium.org/g/embedder-dev/c/ZF3uHHyWLKw/m/VDN2hDXMAAAJ)
	// `FontationsLinuxSystemFonts` - Revert to FreeType for system fonts on Linux Refs https://github.com/microsoft/vscode/issues/260391
	const featuresToDisable =
		`CalculateNativeWinOcclusion,FontationsLinuxSystemFonts,${app.commandLine.getSwitchValue('disable-features')}`;
	app.commandLine.appendSwitch('disable-features', featuresToDisable);

	// Blink features to configure.
	// `FontMatchingCTMigration` - Switch font matching on macOS to Appkit (Refs https://github.com/microsoft/vscode/issues/224496#issuecomment-2270418470).
	// `StandardizedBrowserZoom` - Disable zoom adjustment for bounding box (https://github.com/microsoft/vscode/issues/232750#issuecomment-2459495394)
	const blinkFeaturesToDisable =
		`FontMatchingCTMigration,StandardizedBrowserZoom,${app.commandLine.getSwitchValue('disable-blink-features')}`;
	app.commandLine.appendSwitch('disable-blink-features', blinkFeaturesToDisable);

	// ========================================================================
	// Configure JavaScript flags for V8
	// ========================================================================
	
	// Support JS Flags (passed to V8 JavaScript engine)
	const jsFlags = getJSFlags(cliArgs);
	if (jsFlags) {
		app.commandLine.appendSwitch('js-flags', jsFlags);
	}

	// ========================================================================
	// Configure XDG Portal version (Linux)
	// ========================================================================
	
	// Use portal version 4 that supports current_folder option
	// to address https://github.com/microsoft/vscode/issues/213780
	// Runtime sets the default version to 3, refs https://github.com/electron/electron/pull/44426
	app.commandLine.appendSwitch('xdg-portal-required-version', '4');

	return argvConfig;
}

// ============================================================================
// ARGV CONFIG INTERFACE
// ============================================================================

/**
 * Interface for argv.json configuration file
 * This file allows users to set persistent command-line switches
 */
interface IArgvConfig {
	[key: string]: string | string[] | boolean | undefined;
	readonly locale?: string;                          // UI language (e.g., 'en', 'zh-cn')
	readonly 'disable-lcd-text'?: boolean;             // Disable LCD text antialiasing
	readonly 'proxy-bypass-list'?: string;             // List of proxy bypass hosts
	readonly 'disable-hardware-acceleration'?: boolean; // Disable GPU hardware acceleration
	readonly 'force-color-profile'?: string;           // Force specific color profile
	readonly 'enable-crash-reporter'?: boolean;        // Enable crash reporting
	readonly 'crash-reporter-id'?: string;             // UUID for crash reports
	readonly 'enable-proposed-api'?: string[];         // Extension IDs with proposed API access
	readonly 'log-level'?: string | string[];          // Logging level(s)
	readonly 'disable-chromium-sandbox'?: boolean;     // Disable Chromium sandbox
	readonly 'use-inmemory-secretstorage'?: boolean;   // Use in-memory secrets instead of keychain
	readonly 'enable-rdp-display-tracking'?: boolean;  // Enable RDP display tracking
	readonly 'remote-debugging-port'?: string;         // Port for remote debugging
}

// ============================================================================
// READ ARGV CONFIG
// ============================================================================

/**
 * Reads argv.json configuration file synchronously
 * Must happen before app 'ready' event to configure command-line switches
 */
function readArgvConfigSync(): IArgvConfig {

	// Read or create the argv.json config file sync before app('ready')
	const argvConfigPath = getArgvConfigPath();
	let argvConfig: IArgvConfig | undefined = undefined;
	
	try {
		// Try to read and parse the file
		argvConfig = parse(fs.readFileSync(argvConfigPath).toString());
	} catch (error) {
		// If file doesn't exist, create a default one
		if (error && error.code === 'ENOENT') {
			createDefaultArgvConfigSync(argvConfigPath);
		} else {
			console.warn(`Unable to read argv.json configuration file in ${argvConfigPath}, falling back to defaults (${error})`);
		}
	}

	// Fallback to empty object if parsing failed
	if (!argvConfig) {
		argvConfig = {};
	}

	return argvConfig;
}

// ============================================================================
// CREATE DEFAULT ARGV CONFIG
// ============================================================================

/**
 * Creates a default argv.json file with helpful comments
 */
function createDefaultArgvConfigSync(argvConfigPath: string): void {
	try {

		// Ensure argv config parent directory exists
		const argvConfigPathDirname = path.dirname(argvConfigPath);
		if (!fs.existsSync(argvConfigPathDirname)) {
			fs.mkdirSync(argvConfigPathDirname);
		}

		// Default argv.json content with explanatory comments
		const defaultArgvConfigContent = [
			'// This configuration file allows you to pass permanent command line arguments to VS Code.',
			'// Only a subset of arguments is currently supported to reduce the likelihood of breaking',
			'// the installation.',
			'//',
			'// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT',
			'//',
			'// NOTE: Changing this file requires a restart of VS Code.',
			'{',
			'	// Use software rendering instead of hardware accelerated rendering.',
			'	// This can help in cases where you see rendering issues in VS Code.',
			'	// "disable-hardware-acceleration": true',
			'}'
		];

		// Create initial argv.json with default content
		fs.writeFileSync(argvConfigPath, defaultArgvConfigContent.join('\n'));
	} catch (error) {
		console.error(`Unable to create argv.json configuration file in ${argvConfigPath}, falling back to defaults (${error})`);
	}
}

// ============================================================================
// GET ARGV CONFIG PATH
// ============================================================================

/**
 * Gets the path to argv.json file
 * Location depends on whether we're in portable mode or not
 */
function getArgvConfigPath(): string {
	// If in portable mode, store argv.json in the portable directory
	const vscodePortable = process.env['VSCODE_PORTABLE'];
	if (vscodePortable) {
		return path.join(vscodePortable, 'argv.json');
	}

	// Otherwise, store in user's home directory
	let dataFolderName = product.dataFolderName;
	
	// In development mode, use a different folder name to avoid conflicts
	if (process.env['VSCODE_DEV']) {
		dataFolderName = `${dataFolderName}-dev`;
	}

	return path.join(os.homedir(), dataFolderName!, 'argv.json');
}

// ============================================================================
// CONFIGURE CRASH REPORTER
// ============================================================================

/**
 * Configures the crash reporter to either:
 * 1. Store crashes locally in a specified directory, OR
 * 2. Upload crashes to AppCenter (Microsoft's crash reporting service)
 */
function configureCrashReporter(): void {
	let crashReporterDirectory = args['crash-reporter-directory'];
	let submitURL = '';
	
	// ========================================================================
	// Option 1: Local crash directory (for debugging)
	// ========================================================================
	if (crashReporterDirectory) {
		// Normalize and validate the path
		crashReporterDirectory = path.normalize(crashReporterDirectory);

		// Path must be absolute
		if (!path.isAbsolute(crashReporterDirectory)) {
			console.error(`The path '${crashReporterDirectory}' specified for --crash-reporter-directory must be absolute.`);
			app.exit(1);
		}

		// Create directory if it doesn't exist
		if (!fs.existsSync(crashReporterDirectory)) {
			try {
				fs.mkdirSync(crashReporterDirectory, { recursive: true });
			} catch (error) {
				console.error(`The path '${crashReporterDirectory}' specified for --crash-reporter-directory does not seem to exist or cannot be created.`);
				app.exit(1);
			}
		}

		// Crashes are stored in the crashDumps directory by default, so we
		// need to change that directory to the provided one
		console.log(`Found --crash-reporter-directory argument. Setting crashDumps directory to be '${crashReporterDirectory}'`);
		app.setPath('crashDumps', crashReporterDirectory);
	}

	// ========================================================================
	// Option 2: AppCenter crash reporting (for production builds)
	// ========================================================================
	else {
		const appCenter = product.appCenter;
		if (appCenter) {
			const isWindows = (process.platform === 'win32');
			const isLinux = (process.platform === 'linux');
			const isDarwin = (process.platform === 'darwin');
			
			// Get crash reporter ID (UUID) from argv.json
			const crashReporterId = argvConfig['crash-reporter-id'];
			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			
			// Only configure if we have a valid UUID
			if (crashReporterId && uuidPattern.test(crashReporterId)) {
				// Select the appropriate AppCenter endpoint based on platform and architecture
				if (isWindows) {
					switch (process.arch) {
						case 'x64':
							submitURL = appCenter['win32-x64'];
							break;
						case 'arm64':
							submitURL = appCenter['win32-arm64'];
							break;
					}
				} else if (isDarwin) {
					// Universal build has a single endpoint
					if (product.darwinUniversalAssetId) {
						submitURL = appCenter['darwin-universal'];
					} else {
						switch (process.arch) {
							case 'x64':
								submitURL = appCenter['darwin'];
								break;
							case 'arm64':
								submitURL = appCenter['darwin-arm64'];
								break;
						}
					}
				} else if (isLinux) {
					submitURL = appCenter['linux-x64'];
				}
				
				// Append crash reporter ID as uid, iid, and sid query parameters
				submitURL = submitURL.concat('&uid=', crashReporterId, '&iid=', crashReporterId, '&sid=', crashReporterId);
				
				// Send the id for child node process that are explicitly starting crash reporter.
				// For vscode this is ExtensionHost process currently.
				const argv = process.argv;
				const endOfArgsMarkerIndex = argv.indexOf('--');
				
				// Add crash-reporter-id to process.argv so child processes inherit it
				if (endOfArgsMarkerIndex === -1) {
					// No '--' marker, safe to append at the end
					argv.push('--crash-reporter-id', crashReporterId);
				} else {
					// if the we have an argument "--" (end of argument marker)
					// we cannot add arguments at the end. rather, we add
					// arguments before the "--" marker.
					argv.splice(endOfArgsMarkerIndex, 0, '--crash-reporter-id', crashReporterId);
				}
			}
		}
	}

	// ========================================================================
	// Start the crash reporter
	// ========================================================================
	
	// Get product and company name from product.json (with fallbacks)
	const productName = (product.crashReporter ? product.crashReporter.productName : undefined) || product.nameShort;
	const companyName = (product.crashReporter ? product.crashReporter.companyName : undefined) || 'Microsoft';
	
	// Only upload to server if:
	// - NOT in development mode
	// - AND we have a submit URL
	// - AND we're not using a local crash directory
	const uploadToServer = Boolean(!process.env['VSCODE_DEV'] && submitURL && !crashReporterDirectory);
	
	// Start the crash reporter for all processes (main + renderer)
	crashReporter.start({
		companyName,
		productName: process.env['VSCODE_DEV'] ? `${productName} Dev` : productName,
		submitURL,
		uploadToServer,
		compress: true  // Compress crash dumps before uploading
	});
}

// ============================================================================
// GET JAVASCRIPT FLAGS
// ============================================================================

/**
 * Gets JavaScript flags to pass to V8 engine
 * Returns null if no flags needed
 */
function getJSFlags(cliArgs: NativeParsedArgs): string | null {
	const jsFlags: string[] = [];

	// Add any existing JS flags we already got from the command line
	if (cliArgs['js-flags']) {
		jsFlags.push(cliArgs['js-flags']);
	}

	// Linux-specific workaround for cppgc crash
	if (process.platform === 'linux') {
		// Fix cppgc crash on Linux with 16KB page size.
		// Refs https://issues.chromium.org/issues/378017037
		// The fix from https://github.com/electron/electron/commit/6c5b2ef55e08dc0bede02384747549c1eadac0eb
		// only affects non-renderer process.
		// The following will ensure that the flag will be
		// applied to the renderer process as well.
		// TODO(deepak1556): Remove this once we update to
		// Chromium >= 134.
		jsFlags.push('--nodecommit_pooled_pages');
	}

	// Return flags as space-separated string, or null if no flags
	return jsFlags.length > 0 ? jsFlags.join(' ') : null;
}

// ============================================================================
// PARSE COMMAND LINE ARGUMENTS
// ============================================================================

/**
 * Parses command-line arguments using minimist
 * Specifies which arguments are strings, booleans, and their default values
 */
function parseCLIArgs(): NativeParsedArgs {
	return minimist(process.argv, {
		// Arguments that should be parsed as strings
		string: [
			'user-data-dir',           // Custom user data directory
			'locale',                  // UI language
			'js-flags',                // Flags to pass to V8 JavaScript engine
			'crash-reporter-directory' // Directory for local crash dumps
		],
		// Arguments that should be parsed as booleans
		boolean: [
			'disable-chromium-sandbox', // Disable Chromium sandbox
		],
		// Default values
		default: {
			'sandbox': true  // Sandbox is enabled by default
		},
		// Aliases (e.g., --no-sandbox is an alias for --sandbox=false)
		alias: {
			'no-sandbox': 'sandbox'
		}
	});
}

// ============================================================================
// REGISTER GLOBAL LISTENERS
// ============================================================================

/**
 * Registers global event listeners for macOS-specific features
 * These listeners handle file and URL opening events
 */
function registerListeners(): void {

	// ========================================================================
	// macOS: Handle file dropping before app is ready
	// ========================================================================
	
	/**
	 * macOS: when someone drops a file to the not-yet running VSCode, the open-file event fires even before
	 * the app-ready event. We listen very early for open-file and remember this upon startup as path to open.
	 */
	const macOpenFiles: string[] = [];
	// Store in global so the main application code can access it later
	(globalThis as { macOpenFiles?: string[] }).macOpenFiles = macOpenFiles;
	
	// Listen for open-file events (when user drops files onto dock icon)
	app.on('open-file', function (event, path) {
		macOpenFiles.push(path);
	});

	// ========================================================================
	// macOS: Handle custom URL scheme (vscode://)
	// ========================================================================
	
	/**
	 * macOS: react to open-url requests.
	 * For example: vscode://file/path/to/file
	 */
	const openUrls: string[] = [];
	const onOpenUrl =
		function (event: { preventDefault: () => void }, url: string) {
			event.preventDefault();  // Prevent default URL handling
			openUrls.push(url);
		};

	// Register open-url listener when app is about to finish launching
	app.on('will-finish-launching', function () {
		app.on('open-url', onOpenUrl);
	});

	// Provide a function for the main application to retrieve and clear stored URLs
	(globalThis as { getOpenUrls?: () => string[] }).getOpenUrls = function () {
		// Remove the listener since we're now handling URLs
		app.removeListener('open-url', onOpenUrl);

		// Return all URLs that were opened before app was ready
		return openUrls;
	};
}

// ============================================================================
// GET CODE CACHE PATH
// ============================================================================

/**
 * Gets the path where V8 should cache compiled JavaScript code
 * Code caching significantly improves startup performance
 * 
 * Returns undefined if:
 * - Explicitly disabled via --no-cached-data flag
 * - Running from source (development mode)
 * - No commit ID available (can't identify the version)
 */
function getCodeCachePath(): string | undefined {

	// Explicitly disabled via CLI args
	if (process.argv.indexOf('--no-cached-data') > 0) {
		return undefined;
	}

	// Running out of sources (development mode)
	if (process.env['VSCODE_DEV']) {
		return undefined;
	}

	// Require commit id (to ensure cache matches the code version)
	const commit = product.commit;
	if (!commit) {
		return undefined;
	}

	// Store cache in: <userDataPath>/CachedData/<commit-id>/
	// This ensures each version has its own cache
	return path.join(userDataPath, 'CachedData', commit);
}

// ============================================================================
// MKDIR WITH ERROR HANDLING
// ============================================================================

/**
 * Creates a directory recursively, ignoring errors
 * Used for creating code cache directory
 * 
 * @param dir - Directory path to create
 * @returns The directory path if successful, undefined if error
 */
async function mkdirpIgnoreError(dir: string | undefined): Promise<string | undefined> {
	if (typeof dir === 'string') {
		try {
			await fs.promises.mkdir(dir, { recursive: true });

			return dir;
		} catch (error) {
			// ignore - if directory creation fails, just continue without caching
		}
	}

	return undefined;
}

// ============================================================================
// NLS (NATIONAL LANGUAGE SUPPORT) FUNCTIONS
// ============================================================================

/**
 * Processes Chinese locale strings to normalize them
 * 
 * Chinese locales are complex:
 * - Windows/macOS: Use zh-hans (Simplified) or zh-hant (Traditional)
 * - Linux: Use zh-CN, zh-TW, zh-SG, etc. (country codes)
 * 
 * We normalize these to:
 * - zh-cn for Simplified Chinese
 * - zh-tw for Traditional Chinese
 * 
 * @param appLocale - The locale string from the OS
 * @returns Normalized locale string
 */
function processZhLocale(appLocale: string): string {
	if (appLocale.startsWith('zh')) {
		const region = appLocale.split('-')[1];

		// On Windows and macOS, Chinese languages returned by
		// app.getPreferredSystemLanguages() start with zh-hans
		// for Simplified Chinese or zh-hant for Traditional Chinese,
		// so we can easily determine whether to use Simplified or Traditional.
		// However, on Linux, Chinese languages returned by that same API
		// are of the form zh-XY, where XY is a country code.
		// For China (CN), Singapore (SG), and Malaysia (MY)
		// country codes, assume they use Simplified Chinese.
		// For other cases, assume they use Traditional.
		if (['hans', 'cn', 'sg', 'my'].includes(region)) {
			return 'zh-cn';  // Simplified Chinese
		}

		return 'zh-tw';  // Traditional Chinese
	}

	return appLocale;
}

/**
 * Resolve the NLS configuration
 * This determines which language VS Code should use for its UI
 */
async function resolveNlsConfiguration(): Promise<INLSConfiguration> {

	// First, we need to test a user defined locale.
	// If it fails we try the app locale.
	// If that fails we fall back to English.

	// If we already resolved NLS configuration early (before app ready), use that
	const nlsConfiguration = nlsConfigurationPromise ? await nlsConfigurationPromise : undefined;
	if (nlsConfiguration) {
		return nlsConfiguration;
	}

	// Try to use the app locale which is only valid
	// after the app ready event has been fired.

	// Get the locale from Electron (based on OS settings)
	let userLocale = app.getLocale();
	if (!userLocale) {
		// If Electron can't determine locale, fall back to English
		return {
			userLocale: 'en',
			osLocale,
			resolvedLanguage: 'en',
			defaultMessagesFile: path.join(import.meta.dirname, 'nls.messages.json'),

			// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
			locale: 'en',
			availableLanguages: {}
		};
	}

	// Language tags are case insensitive however an ESM loader is case sensitive
	// To make this work on case preserving & insensitive FS we do the following:
	// the language bundles have lower case language tags and we always lower case
	// the locale we receive from the user or OS.
	userLocale = processZhLocale(userLocale.toLowerCase());

	// Resolve the NLS configuration based on the user's locale
	return resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: product.commit,
		userDataPath,
		nlsMetadataPath: import.meta.dirname
	});
}

/**
 * Get user-defined locale from command-line args or argv.json
 * 
 * @param argvConfig - Configuration from argv.json
 * @returns Locale string (lowercase) or undefined
 */
function getUserDefinedLocale(argvConfig: IArgvConfig): string | undefined {
	// Command-line --locale flag always takes precedence
	const locale = args['locale'];
	if (locale) {
		return locale.toLowerCase(); // a directly provided --locale always wins
	}

	// Otherwise, check argv.json for locale setting
	return typeof argvConfig?.locale === 'string' ? argvConfig.locale.toLowerCase() : undefined;
}

// ============================================================================
// END OF FILE
// ============================================================================
