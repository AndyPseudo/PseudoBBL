import { eventSource, event_types, saveSettings } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SillyTavern } from '../../../../SillyTavern.js';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================
const EXTENSION_NAME = "PseudoBBL";
const LOG_PREFIX = `[${EXTENSION_NAME}]`;

const API_TO_SELECTOR_MAP = {
    'openai': '#model_openai_select',
    'claude': '#model_claude_select',
    'google': '#model_google_select',
    'vertex-ai': '#model_vertexai_select',
    'openrouter': '#model_openrouter_select',
    'mistral': '#model_mistralai_select',
    'groq': '#model_groq_select',
    'cohere': '#model_cohere_select',
    'ai21': '#model_ai21_select',
    'perplexity': '#model_perplexity_select',
    'deepseek': '#model_deepseek_select',
    'aiml': '#model_aimlapi_select',
    'xai': '#model_xai_select',
    '01-ai': '#model_01ai_select',
    'pollinations': '#model_pollinations_select',
    'nanogpt': '#model_nanogpt_select',
};

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================
const defaultSettings = {
    version: 2,
    enabled: false,
    stage1Api: 'google',
    stage1Model: 'gemini-2.5-flash-lite',
    stage2Api: '',
    stage2Model: '',
    analysisPromptTemplate: '',
    lorebookFile: '',
    contextDepth: 5,
    smartRegeneration: true,
    debugMode: false
};

const DEFAULT_ANALYSIS_PROMPT = `#Context[Agentic]{
Agent 1: You
Role: User prompt analysis and response planning
Inputs: Scoped context + Reasoning step Registry
Outputs: Exact strings for Reasoning steps

Agent 2: Additional model instance
Role: Response generation
Inputs: Outputs from Agent 1 + broader context
Outputs: Prose/dialogue
}

##Prompt[Agent 1]{
# Your task is to analyze the conversation history and select the most relevant "Reasoning Steps" (prompts from the registry) to guide the next response from a creative writing AI. Read through the eyes of an author working as a narrative co-pilot.
# Instructions
1.  **Analyze Context:** Carefully read the "Registry" and the "Recent Context" / "Character Info" provided below.
2.  **Reasoning:** First, provide a brief, high-level analysis of the current narrative state. Explain which reasoning steps are most crucial for the next AI response and why.
3.  **Final Output:** Conclude your entire response with a single, specific line containing only the UIDs you have selected. This line MUST be in the exact format: \`<UIDs>24,X,Y,Z,25</UIDs>\`. Do not include any other text after this tag. The list must ALWAYS BEGIN WITH \`24\` and END WITH \`25\`
# Recent Context
{{history}}

# Character Info
{{character}}

# Registry
{{registry}}
}`;

// ============================================================================
// STATE MANAGEMENT & READY QUEUE
// ============================================================================
let pipelineState = {
    isReady: false,
    isRunning: false,
    cachedAnalysis: null,
    debugLog: [],
    isRestoring: false,
    lastActivity: Date.now()
};

let userOriginalSettings = {
    api: null,
    model: null
};

let isAppReady = false;
let readyQueue = [];

function runReadyQueue() {
    isAppReady = true;
    log(`APP_READY received, running ${readyQueue.length} deferred tasks.`);
    while (readyQueue.length > 0) {
        const task = readyQueue.shift();
        try {
            task();
        } catch (error) {
            console.error(`${LOG_PREFIX} A deferred task failed to execute:`, error);
        }
    }
}

function queueReadyTask(task) {
    if (isAppReady) {
        task();
    } else {
        readyQueue.push(task);
    }
}


// ============================================================================
// LOGGING & UTILITIES
// ============================================================================
function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { timestamp, message, data };

    pipelineState.debugLog.push(logEntry);
    if (pipelineState.debugLog.length > 100) {
        pipelineState.debugLog.shift();
    }

    if (extension_settings[EXTENSION_NAME]?.debugMode || data?.error) {
        console.log(`${LOG_PREFIX} ${message}`, data || '');
    }
}

function cleanupResources() {
    if (pipelineState.debugLog.length > 50) {
        pipelineState.debugLog = pipelineState.debugLog.slice(-50);
    }
    if (pipelineState.lastActivity && Date.now() - pipelineState.lastActivity > 600000) {
        pipelineState.cachedAnalysis = null;
        log('Cleared cached analysis due to inactivity.');
    }
}

function validateSettings(settings) {
    const errors = [];
    if (settings.contextDepth < 1 || settings.contextDepth > 50) {
        errors.push('Context depth must be between 1 and 50');
    }
    if (settings.enabled && !settings.stage1Api) {
        errors.push('Stage 1 API must be selected when enabled');
    }
    if (settings.enabled && !settings.lorebookFile) {
        errors.push('Lorebook file must be selected when enabled');
    }
    return errors;
}

// ... (The rest of your utility, API, and pipeline functions remain unchanged) ...
// ... (safeQuerySelector, withTimeout, showDebugLog, showModelSelectorPopup, updateApiDisplay, etc.) ...
// ... (runAnalysisStage, activateLorebooks, getRecentChatMessages, etc. are all fine) ...


// ============================================================================
// UI & INITIALIZATION (RESTRUCTURED)
// ============================================================================

// This function only binds UI elements and can run early.
function initializeUI() {
    const settings = extension_settings[EXTENSION_NAME];

    const enableToggle = document.getElementById('ps_enabled');
    if (enableToggle) {
        enableToggle.onchange = () => {
            settings.enabled = enableToggle.checked;
            saveSettings();
            updateUIState();
            window.toastr.info(`PseudoBBL pipeline ${settings.enabled ? 'enabled' : 'disabled'}.`, LOG_PREFIX);
        };
    }

    ['stage1', 'stage2'].forEach(stage => {
        const selectBtn = document.getElementById(`ps_${stage}SelectBtn`);
        if (selectBtn) selectBtn.onclick = () => showModelSelectorPopup(stage);
    });

    const lorebookSelect = document.getElementById('ps_lorebookFile');
    if (lorebookSelect) {
        lorebookSelect.onchange = () => {
            settings.lorebookFile = lorebookSelect.value;
            saveSettings();
        };
    }

    const analysisPrompt = document.getElementById('ps_analysisPrompt');
    const resetPromptBtn = document.getElementById('ps_resetPrompt');
    if (analysisPrompt && resetPromptBtn) {
        analysisPrompt.value = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
        analysisPrompt.oninput = () => {
            settings.analysisPromptTemplate = analysisPrompt.value;
            saveSettings();
        };
        resetPromptBtn.onclick = () => {
            analysisPrompt.value = DEFAULT_ANALYSIS_PROMPT;
            settings.analysisPromptTemplate = DEFAULT_ANALYSIS_PROMPT;
            saveSettings();
        };
    }

    const contextDepth = document.getElementById('ps_contextDepth');
    if (contextDepth) {
        contextDepth.oninput = () => {
            settings.contextDepth = parseInt(contextDepth.value);
            document.getElementById('ps_contextDepthValue').textContent = contextDepth.value;
            saveSettings();
        };
    }

    const smartRegen = document.getElementById('ps_smartRegeneration');
    if (smartRegen) {
        smartRegen.checked = settings.smartRegeneration;
        smartRegen.onchange = () => {
            settings.smartRegeneration = smartRegen.checked;
            saveSettings();
        };
    }

    const debugMode = document.getElementById('ps_debugMode');
    if (debugMode) {
        debugMode.checked = settings.debugMode;
        debugMode.onchange = () => {
            settings.debugMode = debugMode.checked;
            saveSettings();
        };
    }

    const dryRunBtn = document.getElementById('ps_dryRun');
    if (dryRunBtn) dryRunBtn.onclick = runAnalysisDryRun;
    
    const clearCacheBtn = document.getElementById('ps_clearCache');
    if (clearCacheBtn) {
        clearCacheBtn.onclick = () => {
            pipelineState.cachedAnalysis = null;
            log('Analysis cache cleared by user');
            window.toastr.info('Analysis cache cleared', LOG_PREFIX);
        };
    }
    
    const showDebugBtn = document.getElementById('ps_showDebug');
    if (showDebugBtn) showDebugBtn.onclick = showDebugLog;

    log('UI event listeners bound.');
}

// This is the main initialization function.
async function initializeExtension() {
    log('Initializing PseudoBBL...');
    try {
        // SAFE TASKS: These can run before the app is fully ready.
        extension_settings[EXTENSION_NAME] = { ...defaultSettings, ...extension_settings[EXTENSION_NAME] };
        
        const extensionBasePath = new URL('.', import.meta.url).href;
        const settingsHtml = await fetch(`${extensionBasePath}settings.html`).then(res => res.text());
        
        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', settingsHtml);
        
        initializeUI(); // Binds click handlers etc.
        updateUIState(); // Sets initial UI state from settings

        // DEFERRED TASKS: These must wait until the app is fully ready.
        queueReadyTask(() => {
            log('Running deferred initialization...');
            const settings = extension_settings[EXTENSION_NAME];

            const settingsErrors = validateSettings(settings);
            if (settingsErrors.length > 0) {
                log('Settings validation warnings', { errors: settingsErrors });
                settings.enabled = false;
            }

            // This requires getContext(), so it must be deferred.
            if (!settings.stage2Model) {
                const context = getContext();
                settings.stage2Api = context.api;
                settings.stage2Model = context.model;
                log('Set Stage 2 model to user\'s current selection', { api: context.api, model: context.model });
                saveSettings();
            }

            // Populate lorebook options now that they are loaded.
            populateLorebookOptions(document.getElementById('ps_lorebookFile'));
            updateUIState(); // Final UI update with all data

            // Event bindings MUST be deferred.
            eventSource.makeLast(event_types.GENERATE_BEFORE, async () => {
                const proceed = await handlePipelineTrigger(null, 'generate');
                if (!proceed) pipelineState.cachedAnalysis = null;
            });
            eventSource.on(event_types.GENERATE_AFTER, () => restoreUserSettings());

            if (event_types.MESSAGE_SWIPED) {
                eventSource.on(event_types.MESSAGE_SWIPED, () => log('Swipe detected, cache preserved'));
            }
            eventSource.on(event_types.MESSAGE_DELETED, () => {
                pipelineState.cachedAnalysis = null;
                log('Message deleted, cache cleared');
            });

            pipelineState.isReady = true;
            log('PseudoBBL initialized successfully.');
        });

    } catch (error) {
        console.error(`${LOG_PREFIX} Critical initialization failure:`, error);
        window.toastr.error(`PseudoBBL failed to initialize. Check console (F12).`, LOG_PREFIX);
        pipelineState.isReady = false;
    }
}


// ============================================================================
// EXTENSION ENTRY POINT
// ============================================================================
$(document).ready(() => {
    // 1. Register the APP_READY listener to process the queue when SillyTavern is fully loaded.
    eventSource.on(event_types.APP_READY, runReadyQueue);

    // 2. Kick off our own initialization logic immediately.
    // It will perform safe tasks and queue the rest.
    initializeExtension();
    
    // 3. Start the periodic cleanup task.
    setInterval(cleanupResources, 300000); // Run cleanup every 5 minutes
});

// NOTE: All other functions (updateUIState, runAnalysisStage, etc.) are assumed to be present and correct as in your original file.
// The primary changes are in the initialization flow above.
