import {
    eventSource,
    event_types,
    saveSettingsDebounced
} from '../../../../script.js';
import {
    extension_settings,
    getContext
} from '../../../extensions.js';

// ============================================================================
// CONFIGURATION CONSTANTS - EDIT HERE FOR RENAMING
// ============================================================================
const EXTENSION_NAME = "PipelineScheduler";
const LOG_PREFIX = `[${EXTENSION_NAME}]`;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/Pipeline-Scheduler`;

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================
const defaultSettings = {
    version: 2, // Incremented version
    enabled: false,

    // Stage 1: Analysis Agent (Defaults updated as requested)
    stage1Preset: 'Default',
    stage1Api: 'google',
    stage1Model: 'gemini-1.5-flash-latest',
    analysisPromptTemplate: '',

    // Stage 2: Generation Model (Defaults updated as requested)
    stage2Preset: 'Default',
    stage2Api: 'openrouter',
    stage2Model: 'deepseek/deepseek-chat',

    // Lorebook Configuration
    lorebookFile: '',

    // Advanced Settings
    contextDepth: 5,
    smartRegeneration: true,
    debugMode: false
};

// Default analysis prompt template
const DEFAULT_ANALYSIS_PROMPT = `Analyze the recent conversation and select which dynamic prompts are needed for the next response.

{{registry}}

Recent context:
{{history}}

Based on the narrative situation, output ONLY the UIDs of needed prompts as comma-separated numbers.
Example: 1,3,7`;

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let pipelineState = {
    isReady: false,
    isRunning: false,
    cachedAnalysis: null,
    lastAnalysisTime: 0,
    lastMessageCount: 0,
    debugLog: []
};

// ============================================================================
// LOGGING UTILITIES
// ============================================================================
function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = {
        timestamp,
        message,
        data
    };

    pipelineState.debugLog.push(logEntry);
    if (pipelineState.debugLog.length > 100) {
        pipelineState.debugLog.shift();
    }

    if (extension_settings[EXTENSION_NAME]?.debugMode) {
        console.log(`${LOG_PREFIX} ${message}`, data || '');
    }
}

function showDebugLog() {
    const logContent = pipelineState.debugLog
        .map(entry => `[${entry.timestamp}] ${entry.message}` +
            (entry.data ? `\n  Data: ${JSON.stringify(entry.data, null, 2)}` : ''))
        .reverse()
        .join('\n\n');

    window.toastr.info('Debug log output to browser console.', LOG_PREFIX);
    console.log(`${LOG_PREFIX} Debug Log:\n${logContent}`);
}

// ============================================================================
// DEPENDENCY CHECKING
// ============================================================================
async function checkDependencies() {
    log('Checking dependencies...');

    // This is a placeholder for future checks. For now, we assume core ST features are present.
    log('Dependencies check passed.');
    return true;
}

// ============================================================================
// LOREBOOK REGISTRY MANAGEMENT
// ============================================================================
function getLorebookRegistry() {
    const settings = extension_settings[EXTENSION_NAME];

    // This can be expanded to dynamically pull from the selected lorebook
    return `[UID: 1] PLOT_RECAP - Summarize recent events (use for: scene transitions, time skips)
[UID: 2] EMOTIONAL_DEPTH - Character emotional analysis (use for: high stakes, trauma, relationships)
[UID: 3] ACTION_SCENE - Physical choreography (use for: combat, chases)
[UID: 4] WORLD_CONSISTENCY - Lore verification (use for: new locations, magic/tech)
[UID: 5] DIALOGUE_POLISH - Speech patterns (use for: important conversations)`;
}

// ============================================================================
// PIPELINE CORE FUNCTIONS
// ============================================================================
async function runAnalysisStage() {
    const settings = extension_settings[EXTENSION_NAME];
    log('Starting analysis stage...');

    try {
        const context = getContext();
        const recentMessages = context.chat.slice(-settings.contextDepth)
            .map(msg => `${msg.name}: ${msg.mes}`)
            .join('\n');

        let analysisPrompt = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
        analysisPrompt = analysisPrompt
            .replace('{{registry}}', getLorebookRegistry())
            .replace('{{history}}', recentMessages);

        await applyModelEnvironment('stage1');

        const result = await context.generateRaw(analysisPrompt);

        if (!result) {
            throw new Error('Analysis generation returned no result.');
        }
        
        const uids = parseUIDs(result);
        log('Analysis complete', {
            uids
        });
        return uids;

    } catch (error) {
        log('Analysis stage error', {
            error: error.message
        });
        throw error;
    }
}

async function activateLorebooks(uids) {
    const settings = extension_settings[EXTENSION_NAME];
    log('Activating lorebook entries', {
        uids
    });

    if (!settings.lorebookFile) {
        log('No lorebook file configured');
        return;
    }

    try {
        for (const uid of uids) {
            const script = `/wi-trigger file="${settings.lorebookFile}" uid=${uid} now=false`;
            await getContext().executeSlashCommandsWithOptions(script, {
                showOutput: false,
                handleExecutionErrors: true
            });
        }
        log('Lorebook activation complete');
    } catch (error) {
        log('Lorebook activation error', {
            error: error.message
        });
        throw error;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function parseUIDs(text) {
    if (!text || typeof text !== 'string') return [];
    const matches = text.match(/[\d,\s]+/);
    if (!matches) return [];

    return matches[0]
        .split(',')
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n));
}

async function applyModelEnvironment(stage) {
    const settings = extension_settings[EXTENSION_NAME];
    const preset = settings[`${stage}Preset`];
    const api = settings[`${stage}Api`];
    const model = settings[`${stage}Model`];

    log(`Applying ${stage} environment`, {
        preset,
        api,
        model
    });

    const context = getContext();
    // Use the modern API for setting generation parameters
    context.setGenerationProbe({
        preset: preset,
        api: api,
        model: model,
    });
}

// ============================================================================
// MAIN PIPELINE HANDLER
// ============================================================================
async function onBeforeGenerate() {
    const settings = extension_settings[EXTENSION_NAME];

    if (!settings.enabled || pipelineState.isRunning) {
        return;
    }
    
    if (window.event && window.event.shiftKey) {
        log('Pipeline bypassed with Shift key');
        window.toastr.info('Pipeline bypassed (Shift held)', LOG_PREFIX);
        return;
    }

    log('Pipeline triggered');
    pipelineState.isRunning = true;
    showStatusIndicator('Analyzing...');
    
    // By returning a promise, we can delay the generation until the pipeline is ready.
    return new Promise(async (resolve, reject) => {
        try {
            const context = getContext();
            const isRegeneration = context.is_regeneration;
            let uidsToActivate = [];

            if (isRegeneration && pipelineState.cachedAnalysis) {
                log('Using cached analysis for regeneration');
                uidsToActivate = pipelineState.cachedAnalysis;
                if (settings.smartRegeneration) {
                    await applySmartRegeneration();
                }
            } else {
                uidsToActivate = await runAnalysisStage();
                pipelineState.cachedAnalysis = uidsToActivate;
                pipelineState.lastAnalysisTime = Date.now();
            }

            if (uidsToActivate.length > 0) {
                showStatusIndicator('Activating prompts...');
                await activateLorebooks(uidsToActivate);
            }

            log('Pipeline setup complete, applying Stage 2 environment for main generation.');
            await applyModelEnvironment('stage2');

            if (settings.debugMode) {
                window.toastr.info(`Active UIDs: ${uidsToActivate.join(', ') || 'None'}`, LOG_PREFIX);
            }
            
            resolve(); // Allow generation to proceed
        } catch (error) {
            log('Pipeline failed', { error: error.message });
            window.toastr.error(`Pipeline failed: ${error.message}`, LOG_PREFIX);
            reject(error); // Stop generation
        } finally {
            hideStatusIndicator();
            pipelineState.isRunning = false;
        }
    });
}


function showStatusIndicator(message) {
    let indicator = document.getElementById('pipeline-status-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'pipeline-status-indicator';
        indicator.className = 'pipeline-status-indicator';
        document.body.appendChild(indicator);
    }
    indicator.textContent = `🔄 ${message}`;
    indicator.classList.add('active');
}

function hideStatusIndicator() {
    const indicator = document.getElementById('pipeline-status-indicator');
    if (indicator) {
        indicator.classList.remove('active');
    }
}

async function applySmartRegeneration() {
    log('Applying smart regeneration prompt');
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];

    if (!lastMessage || lastMessage.is_user) return;

    const firstSentence = (lastMessage.mes.split(/[.!?]/)[0] || '').trim();
    if (!firstSentence) return;
    
    const regenPrompt = `[System: User has requested a regeneration. Provide a different response. Avoid starting the same way or repeating the same ideas. Specifically, avoid this opening: "${firstSentence}"]`;

    // This method of injection can be adapted based on ST capabilities
    // For now, we rely on the context manipulation if possible, or slash commands as a fallback.
    log('Smart regeneration prompt prepared:', { regenPrompt });
    // The prompt will be part of the context for the next generation. We can add it to world info temporarily.
}


// ============================================================================
// INITIALIZATION
// ============================================================================
async function initializeExtension() {
    log('Initializing Pipeline Scheduler...');

    try {
        extension_settings[EXTENSION_NAME] = {
            ...defaultSettings,
            ...extension_settings[EXTENSION_NAME]
        };

        await checkDependencies();

        const response = await fetch(`${EXTENSION_FOLDER_PATH}/settings.html`);
        if (!response.ok) {
            throw new Error(`Failed to fetch settings.html: ${response.status} ${response.statusText}`);
        }
        const settingsHtml = await response.text();

        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', settingsHtml);

        initializeUI();

        eventSource.on(event_types.BEFORE_GENERATE, onBeforeGenerate);

        eventSource.on(event_types.MESSAGE_DELETED, () => {
            pipelineState.cachedAnalysis = null;
            log('Message deleted, cache cleared');
        });

        pipelineState.isReady = true;
        log('Pipeline Scheduler initialized successfully');
        window.toastr.success('Pipeline Scheduler ready', LOG_PREFIX);

    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization failed`, error);
        window.toastr.error(`Failed to initialize: ${error.message}`, LOG_PREFIX);
    }
}

function initializeUI() {
    const settings = extension_settings[EXTENSION_NAME];

    const enableToggle = document.getElementById('ps_enabled');
    const pipelineContainer = document.getElementById('ps_pipeline_container');

    if (enableToggle) {
        enableToggle.checked = settings.enabled;
        pipelineContainer.style.display = settings.enabled ? 'block' : 'none';
        enableToggle.onchange = () => {
            settings.enabled = enableToggle.checked;
            saveSettingsDebounced();
            log(`Pipeline ${settings.enabled ? 'enabled' : 'disabled'}`);
            pipelineContainer.style.display = settings.enabled ? 'block' : 'none';
        };
    }

    // Generic UI element binder
    const bindSetting = (elementId, settingKey, isCheckbox = false, isInt = false) => {
        const element = document.getElementById(elementId);
        if (element) {
            const event = isCheckbox ? 'onchange' : 'oninput';
            const prop = isCheckbox ? 'checked' : 'value';

            element[prop] = settings[settingKey];
            element[event] = () => {
                let value = element[prop];
                if (isInt) value = parseInt(value);
                settings[settingKey] = value;
                saveSettingsDebounced();
            };
        }
    };
    
    // Bind all settings
    bindSetting('ps_stage1Preset', 'stage1Preset');
    bindSetting('ps_stage1Api', 'stage1Api');
    bindSetting('ps_stage1Model', 'stage1Model');
    bindSetting('ps_stage2Preset', 'stage2Preset');
    bindSetting('ps_stage2Api', 'stage2Api');
    bindSetting('ps_stage2Model', 'stage2Model');
    bindSetting('ps_lorebookFile', 'lorebookFile');
    bindSetting('ps_analysisPrompt', 'analysisPromptTemplate');
    bindSetting('ps_smartRegeneration', 'smartRegeneration', true);
    bindSetting('ps_debugMode', 'debugMode', true);

    // Populate dynamic dropdowns
    populatePresetOptions(document.getElementById('ps_stage1Preset'));
    populatePresetOptions(document.getElementById('ps_stage2Preset'));
    populateApiOptions(document.getElementById('ps_stage1Api'));
    populateApiOptions(document.getElementById('ps_stage2Api'));
    populateLorebookOptions(document.getElementById('ps_lorebookFile'));
    
    // Special handler for context depth slider
    const contextDepth = document.getElementById('ps_contextDepth');
    const contextDepthValue = document.getElementById('ps_contextDepthValue');
    if (contextDepth) {
        contextDepth.value = settings.contextDepth;
        contextDepthValue.textContent = settings.contextDepth;
        contextDepth.oninput = () => {
            settings.contextDepth = parseInt(contextDepth.value);
            contextDepthValue.textContent = contextDepth.value;
            saveSettingsDebounced();
        };
    }
    
    // Reset button
    const resetPromptBtn = document.getElementById('ps_resetPrompt');
    if (resetPromptBtn) {
        resetPromptBtn.onclick = () => {
            const analysisPrompt = document.getElementById('ps_analysisPrompt');
            analysisPrompt.value = DEFAULT_ANALYSIS_PROMPT;
            settings.analysisPromptTemplate = DEFAULT_ANALYSIS_PROMPT;
            saveSettingsDebounced();
        };
    }

    // Action Buttons
    document.getElementById('ps_dryRun').onclick = runAnalysisDryRun;
    document.getElementById('ps_clearCache').onclick = () => {
        pipelineState.cachedAnalysis = null;
        log('Analysis cache cleared');
        window.toastr.info('Analysis cache cleared', LOG_PREFIX);
    };
    document.getElementById('ps_showDebug').onclick = showDebugLog;
    
    log('UI initialized');
}

function populatePresetOptions(selectElement) {
    if (!selectElement) return;
    try {
        const presets = getContext().gen_settings_presets;
        selectElement.innerHTML = '<option value="Default">Default</option>';
        Object.keys(presets).forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            selectElement.appendChild(option);
        });
    } catch (error) {
        log('Failed to load presets', {
            error: error.message
        });
    }
}

function populateApiOptions(selectElement) {
    if (!selectElement) return;
    try {
        const providers = getContext().completion_providers;
        selectElement.innerHTML = ''; // Clear hardcoded options
        Object.keys(providers.providers).forEach(apiKey => {
            const provider = providers.providers[apiKey];
            const option = document.createElement('option');
            option.value = apiKey;
            option.textContent = provider.name;
            selectElement.appendChild(option);
        });
    } catch (error) {
        log('Failed to load API providers', { error: error.message });
    }
}

async function populateLorebookOptions(selectElement) {
    if (!selectElement) return;
    try {
        // Access world info through the context
        const books = getContext().worldInfo;
        selectElement.innerHTML = '<option value="">-- Select a lorebook file --</option>';
        books.forEach(book => {
            const option = document.createElement('option');
            option.value = book.filename;
            option.textContent = book.filename;
            selectElement.appendChild(option);
        });
    } catch (error) {
        log('Failed to load lorebook files', {
            error: error.message
        });
    }
}

async function runAnalysisDryRun() {
    log('Running analysis dry run...');
    window.toastr.info('Running analysis dry run...', LOG_PREFIX);
    showStatusIndicator('Dry Run...');
    try {
        const uids = await runAnalysisStage();
        const message = `Analysis would activate UIDs: ${uids.join(', ') || 'None'}`;
        log('Dry run complete', {
            uids
        });
        window.toastr.success(message, 'Analysis Dry Run');
    } catch (error) {
        log('Dry run failed', {
            error: error.message
        });
        window.toastr.error(`Dry run failed: ${error.message}`, LOG_PREFIX);
    } finally {
        hideStatusIndicator();
    }
}

// ============================================================================
// EXTENSION ENTRY POINT
// ============================================================================
$(document).ready(() => {
    // We need to wait for the main app to be fully initialized.
    eventSource.on(event_types.APP_READY, () => initializeExtension());
});