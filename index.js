// index.js

import { eventSource, event_types, saveSettings } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// Import the core logic from our new file
import { 
    runAnalysisStage, 
    activateLorebooks, 
    applyModelEnvironment, 
    getLorebookRegistry 
} from './pipeline.js';

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
const defaultSettings = Object.freeze({
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
});

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
// STATE MANAGEMENT & SETTINGS
// ============================================================================
function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[EXTENSION_NAME], key)) {
            extension_settings[EXTENSION_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[EXTENSION_NAME];
}

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

// ============================================================================
// LOGGING & UTILITIES
// ============================================================================
function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { timestamp, message, data };

    pipelineState.debugLog.push(logEntry);
    if (pipelineState.debugLog.length > 50) {
        pipelineState.debugLog.shift();
    }

    if (getSettings().debugMode) {
        console.log(`${LOG_PREFIX} ${message}`, data || '');
    }
}

function cleanupResources() {
    if (pipelineState.debugLog.length > 25) {
        pipelineState.debugLog = pipelineState.debugLog.slice(-25);
    }
    if (pipelineState.lastActivity && Date.now() - pipelineState.lastActivity > 600000) {
        pipelineState.cachedAnalysis = null;
        log('Cleared cached analysis due to inactivity.');
    }
}

function showDebugLog() {
    const logContent = pipelineState.debugLog
        .map(entry => `[${entry.timestamp}] ${entry.message}` + (entry.data ? `\n  Data: ${JSON.stringify(entry.data, null, 2)}` : ''))
        .reverse().join('\n\n');
    const popupContent = document.createElement('div');
    popupContent.innerHTML = `<h4>Pipeline Scheduler Debug Log</h4><textarea readonly style="width: 100%; height: 70vh; font-family: monospace;">${logContent}</textarea>`;
    callGenericPopup(popupContent, POPUP_TYPE.TEXT, 'Debug Log', { wide: true, large: true });
}

// ============================================================================
// UI & POPUPS
// ============================================================================
async function showModelSelectorPopup(stage) {
    const settings = getSettings();
    const stageUpper = stage === 'stage1' ? 'Stage 1' : 'Stage 2';
    const currentApi = settings[`${stage}Api`];
    const currentModel = settings[`${stage}Model`];

    const popupContent = document.createElement('div');
    popupContent.innerHTML = `
        <div style="margin-bottom: 10px;">
            <label>API Provider:</label>
            <select id="ps-popup-api-select" class="text_pole"></select>
        </div>
        <div>
            <label>Model:</label>
            <select id="ps-popup-model-select" class="text_pole"></select>
        </div>`;

    const apiSelect = popupContent.querySelector('#ps-popup-api-select');
    const modelSelect = popupContent.querySelector('#ps-popup-model-select');

    Object.keys(API_TO_SELECTOR_MAP).forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        apiSelect.appendChild(option);
    });
    apiSelect.value = currentApi;

    const populateModels = (api) => {
        modelSelect.innerHTML = '';
        const selectorId = API_TO_SELECTOR_MAP[api];
        if (selectorId) {
            const sourceSelect = document.querySelector(selectorId);
            if (sourceSelect) {
                Array.from(sourceSelect.options).forEach(option => {
                    if (option.value) modelSelect.appendChild(option.cloneNode(true));
                });
                modelSelect.value = currentModel;
                if (!modelSelect.value && modelSelect.options.length > 0) {
                    modelSelect.selectedIndex = 0;
                }
            } else {
                log(`Could not find model source for API: ${api}`, { selector: selectorId });
            }
        }
    };

    populateModels(currentApi);
    apiSelect.onchange = () => populateModels(apiSelect.value);

    if (await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, `Select Model for ${stageUpper}`)) {
        settings[`${stage}Api`] = apiSelect.value;
        settings[`${stage}Model`] = modelSelect.value;
        saveSettings();
        updateApiDisplay(stage);
        window.toastr.success(`Settings saved for ${stageUpper}.`);
    }
}

function updateApiDisplay(stage) {
    const settings = getSettings();
    const display = document.getElementById(`ps_${stage}ApiDisplay`);
    if (display) {
        const api = settings[`${stage}Api`] || 'N/A';
        const model = settings[`${stage}Model`] || 'Not Set';
        const displayName = api.charAt(0).toUpperCase() + api.slice(1);
        display.textContent = `${displayName} / ${model}`;
    }
}

function getRecentChatMessages(depth) {
    const chatDiv = document.querySelector('#chat');
    if (!chatDiv) return 'No chat history available.';
    
    const messages = Array.from(chatDiv.querySelectorAll('.mes'))
        .slice(-Math.max(1, depth))
        .map(msg => {
            const nameEl = msg.querySelector('.ch_name');
            const textEl = msg.querySelector('.mes_text');
            const name = nameEl?.textContent?.trim() || 'Unknown';
            const text = textEl?.textContent?.trim() || '';
            return `${name}: ${text}`;
        })
        .filter(msg => msg.trim() !== ': ');
    return messages.length > 0 ? messages.join('\n') : 'No valid messages found.';
}

function getCharacterData() {
    const context = getContext();
    if (!context || !context.characterId) return "No character loaded.";
    const character = context.characters[context.characterId];
    if (!character) return "Could not find character data.";
    let profile = `Name: ${character.name}\n`;
    if (character.description) profile += `Description: ${character.description}\n`;
    if (character.personality) profile += `Personality: ${character.personality}\n`;
    return profile.trim();
}

// ============================================================================
// PIPELINE ORCHESTRATION
// ============================================================================
async function handlePipelineTrigger(eventType) {
    const settings = getSettings();
    pipelineState.lastActivity = Date.now();
    if (!settings.enabled || pipelineState.isRunning) return false;
    
    if (window.event && window.event.shiftKey) {
        log('Pipeline bypassed with Shift key');
        window.toastr.info('Pipeline bypassed (Shift held)', LOG_PREFIX);
        return false;
    }
    
    log('Pipeline triggered', { eventType });
    pipelineState.isRunning = true;
    showStatusIndicator('Analyzing...');
    
    const context = getContext();
    userOriginalSettings.api = context.api;
    userOriginalSettings.model = context.model;
    log('Saved user settings', { ...userOriginalSettings });

    try {
        const isRegeneration = eventType === 'swipe' || eventType === 'regenerate';
        let uidsToActivate = [];

        if (isRegeneration && pipelineState.cachedAnalysis) {
            log('Using cached analysis for regeneration');
            uidsToActivate = pipelineState.cachedAnalysis;
            if (settings.smartRegeneration) {
                showStatusIndicator('Applying smart regeneration...');
                await applySmartRegeneration();
            }
        } else {
            showStatusIndicator('Running analysis...');
            const recentMessages = getRecentChatMessages(settings.contextDepth);
            const characterProfile = getCharacterData();
            const registryContent = await getLorebookRegistry(settings.lorebookFile);

            const analysisPrompt = (settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT)
                .replace('{{registry}}', registryContent)
                .replace('{{history}}', recentMessages)
                .replace('{{character}}', characterProfile);
            
            uidsToActivate = await runAnalysisStage(settings, analysisPrompt);
            pipelineState.cachedAnalysis = uidsToActivate;
            log('Analysis complete', { uids: uidsToActivate });
        }

        if (uidsToActivate.length > 0) {
            showStatusIndicator('Activating prompts...');
            await activateLorebooks(settings, uidsToActivate);
            log('Lorebook activation complete');
        }
        
        await applyModelEnvironment(settings, 'stage2');
        showStatusIndicator('Generating response...');
        log('Pipeline setup complete, generation will proceed');
        return true; // Allow generation to proceed
    } catch (error) {
        log('Pipeline failed', { error: error.message });
        window.toastr.error(`Pipeline failed: ${error.message}`, LOG_PREFIX);
        await restoreUserSettings();
        return false; // Block generation
    } finally {
        pipelineState.isRunning = false;
        hideStatusIndicator();
    }
}

async function restoreUserSettings() {
    if (!userOriginalSettings.api || !userOriginalSettings.model || pipelineState.isRestoring) {
        return;
    }
    pipelineState.isRestoring = true;
    try {
        log('Restoring user settings...', { ...userOriginalSettings });
        const commands = [
            `/api ${userOriginalSettings.api}`,
            `/model "${userOriginalSettings.model}"`
        ];
        await getContext().executeSlashCommandsWithOptions(
            commands.join(' | '),
            { showOutput: false, handleExecutionErrors: true, timeout: 5000 }
        );
        userOriginalSettings.api = null;
        userOriginalSettings.model = null;
        log('User settings restored successfully');
    } catch (error) {
        log('Settings restoration failed', { error: error.message });
        window.toastr.warning('Failed to restore original model settings', LOG_PREFIX);
    } finally {
        pipelineState.isRestoring = false;
    }
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
    if (indicator) indicator.classList.remove('active');
}

async function applySmartRegeneration() {
    log('Applying smart regeneration prompt');
    const lastMessage = document.querySelector('.mes:last-child .mes_text')?.textContent || '';
    const firstSentence = lastMessage.split(/[.!?]/)[0];
    const regenPrompt = `[User regenerated. Generate an alternative response. Avoid starting with or repeating: "${firstSentence}"]`;
    await getContext().executeSlashCommandsWithOptions(`/inject id=smart_regen position=chat depth=0 role=system ${JSON.stringify(regenPrompt)}`, { showOutput: false, handleExecutionErrors: true });
}

async function runAnalysisDryRun() {
    log('Running analysis dry run...');
    window.toastr.info('Running analysis dry run...', LOG_PREFIX);
    try {
        const settings = getSettings();
        const recentMessages = getRecentChatMessages(settings.contextDepth);
        const characterProfile = getCharacterData();
        const registryContent = await getLorebookRegistry(settings.lorebookFile);
        const analysisPrompt = (settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT)
            .replace('{{registry}}', registryContent)
            .replace('{{history}}', recentMessages)
            .replace('{{character}}', characterProfile);
            
        const uids = await runAnalysisStage(settings, analysisPrompt);
        const message = `Analysis would activate UIDs: ${uids.join(', ') || 'None'}`;
        log('Dry run complete', { uids });
        window.toastr.success(message, 'Analysis Dry Run');
    } catch (error) {
        log('Dry run failed', { error: error.message });
        window.toastr.error(`Dry run failed: ${error.message}`, LOG_PREFIX);
    }
}

async function populateLorebookOptions(selectElement) {
    if (!selectElement) return;
    try {
        selectElement.innerHTML = '<option value="">-- Select a lorebook file --</option>';
        document.querySelectorAll('#world_editor_select option').forEach(option => {
            if (option.value) selectElement.appendChild(option.cloneNode(true));
        });
    } catch (error) {
        log('Failed to load lorebook files', { error: error.message });
    }
}

// ============================================================================
// UI STATE & INITIALIZATION
// ============================================================================
function updateUIState() {
    const settings = getSettings();
    const enableToggle = document.getElementById('ps_enabled');
    const container = document.getElementById('ps_pipeline_container');
    if (enableToggle) {
        enableToggle.checked = settings.enabled;
        if (container) {
            container.style.display = settings.enabled ? 'block' : 'none';
        }
    }
    ['stage1', 'stage2'].forEach(stage => updateApiDisplay(stage));
    const lorebookSelect = document.getElementById('ps_lorebookFile');
    if (lorebookSelect) {
        lorebookSelect.value = settings.lorebookFile || '';
    }
    const contextDepth = document.getElementById('ps_contextDepth');
    const contextDepthValue = document.getElementById('ps_contextDepthValue');
    if (contextDepth && contextDepthValue) {
        contextDepth.value = settings.contextDepth;
        contextDepthValue.textContent = settings.contextDepth;
    }
    document.getElementById('ps_smartRegeneration').checked = settings.smartRegeneration;
    document.getElementById('ps_debugMode').checked = settings.debugMode;
    document.getElementById('ps_analysisPrompt').value = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
}

function initializeUI() {
    const settings = getSettings();

    document.getElementById('ps_enabled').onchange = (event) => {
        settings.enabled = event.target.checked;
        saveSettings();
        updateUIState();
        window.toastr.info(`PseudoBBL pipeline ${settings.enabled ? 'enabled' : 'disabled'}.`, LOG_PREFIX);
    };

    ['stage1', 'stage2'].forEach(stage => {
        document.getElementById(`ps_${stage}SelectBtn`).onclick = () => showModelSelectorPopup(stage);
    });

    document.getElementById('ps_lorebookFile').onchange = (event) => {
        settings.lorebookFile = event.target.value;
        saveSettings();
    };

    const analysisPromptEl = document.getElementById('ps_analysisPrompt');
    analysisPromptEl.oninput = () => {
        settings.analysisPromptTemplate = analysisPromptEl.value;
        saveSettings();
    };
    document.getElementById('ps_resetPrompt').onclick = () => {
        analysisPromptEl.value = DEFAULT_ANALYSIS_PROMPT;
        settings.analysisPromptTemplate = DEFAULT_ANALYSIS_PROMPT;
        saveSettings();
    };

    const contextDepthEl = document.getElementById('ps_contextDepth');
    contextDepthEl.oninput = () => {
        settings.contextDepth = parseInt(contextDepthEl.value);
        document.getElementById('ps_contextDepthValue').textContent = contextDepthEl.value;
        saveSettings();
    };

    document.getElementById('ps_smartRegeneration').onchange = (event) => {
        settings.smartRegeneration = event.target.checked;
        saveSettings();
    };

    document.getElementById('ps_debugMode').onchange = (event) => {
        settings.debugMode = event.target.checked;
        saveSettings();
    };

    document.getElementById('ps_dryRun').onclick = runAnalysisDryRun;
    document.getElementById('ps_clearCache').onclick = () => {
        pipelineState.cachedAnalysis = null;
        log('Analysis cache cleared');
        window.toastr.info('Analysis cache cleared', LOG_PREFIX);
    };
    document.getElementById('ps_showDebug').onclick = showDebugLog;

    log('UI initialized');
}

async function initializeExtension() {
    try {
        const settings = getSettings();

        const extensionBasePath = new URL('.', import.meta.url).href;
        const settingsHtml = await fetch(`${extensionBasePath}settings.html`).then(res => res.text());
        
        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', settingsHtml);
        initializeUI();

        if (!settings.stage2Model) {
            const context = getContext();
            settings.stage2Api = context.api;
            settings.stage2Model = context.model;
            log('Set Stage 2 model to user\'s current selection', { api: context.api, model: context.model });
            saveSettings();
        }
        
        await populateLorebookOptions(document.getElementById('ps_lorebookFile'));
        updateUIState();

        eventSource.makeLast(event_types.GENERATE_BEFORE, async () => {
            const proceed = await handlePipelineTrigger('generate');
            if (!proceed) pipelineState.cachedAnalysis = null;
        });
        eventSource.on(event_types.GENERATE_AFTER, () => restoreUserSettings());

        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => handlePipelineTrigger('swipe'));
        }
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            pipelineState.cachedAnalysis = null;
            log('Message deleted, cache cleared');
        });

        pipelineState.isReady = true;
        log('Pipeline Scheduler initialized successfully');
    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization failed:`, error);
        window.toastr.error(`Failed to initialize: ${error.message}. Check console (F12).`, LOG_PREFIX);
    }
}

// ============================================================================
// EXTENSION ENTRY POINT
// ============================================================================
$(document).ready(() => {
    eventSource.on(event_types.APP_READY, () => {
        setTimeout(initializeExtension, 100);
        setInterval(cleanupResources, 300000);
    });
});
