// ============================================================================
//  CONSTANTS & CONFIGURATION
// ============================================================================
const EXTENSION_NAME = "PseudoBBL";
const LOG_PREFIX = `[${EXTENSION_NAME}]`;

/**
 * @typedef {object} Settings
 * @property {number} version
 * @property {boolean} enabled
 * @property {string} stage1Api
 * @property {string} stage1Model
 * @property {string} stage2Api
 * @property {string} stage2Model
 * @property {string} analysisPromptTemplate
 * @property {string} lorebookFile
 * @property {number} contextDepth
 * @property {boolean} smartRegeneration
 * @property {boolean} debugMode
 */

/** @type {Settings} */
const defaultSettings = Object.freeze({
    version: 3,
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
3.  **Final Output:** Conclude your entire response with a single, specific line containing only the UIDs you have selected. This line MUST be in the exact format: \`<UIDs>X,Y,Z</UIDs>\`. Do not include any other text after this tag.
# Recent Context
{{history}}

# Character Info
{{character}}

# Registry
{{registry}}
}`;

const API_TO_SELECTOR_MAP = Object.freeze({
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
});


// ============================================================================
//  IMPORTS & MODULE-LEVEL VARIABLES
// ============================================================================
//
import { eventSource, event_types, saveSettings } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { callGenericPopup, POPUP_TYPE } from '/scripts/popup.js';

let pipelineState = {
    isReady: false,
    isRunning: false,
    cachedAnalysis: null,
    debugLog: [],
    isRestoring: false,
    lastActivity: Date.now(),
    dependenciesMet: false,
};
let userOriginalSettings = { api: null, model: null };
let debounceTimer;


// ============================================================================
//  UTILITIES & STATE MANAGEMENT
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

function log(message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { timestamp, message, data };
    pipelineState.debugLog.push(logEntry);
    if (pipelineState.debugLog.length > 100) pipelineState.debugLog.shift();
    if (getSettings().debugMode) console.log(`${LOG_PREFIX} ${message}`, data || '');
}

function showDebugLog() {
    const logContent = pipelineState.debugLog
        .map(entry => `[${entry.timestamp}] ${entry.message}` + (entry.data ? `\n  Data: ${JSON.stringify(entry.data, null, 2)}` : ''))
        .reverse().join('\n\n');
    const popupContent = document.createElement('div');
    popupContent.innerHTML = `<h4>PseudoBBL Debug Log</h4><textarea readonly style="width: 100%; height: 70vh; font-family: monospace; resize: none;">${logContent}</textarea>`;
    callGenericPopup(popupContent, POPUP_TYPE.TEXT, 'Debug Log', { wide: true, large: true });
}

function checkDependencies() {
    if (typeof window.LALib === 'undefined') {
        log('Dependency check failed: LALib is not available.');
        pipelineState.dependenciesMet = false;
        return false;
    }
    log('All dependencies are met.');
    pipelineState.dependenciesMet = true;
    return true;
}

function updateApiDisplay(stage) {
    const settings = getSettings();
    const display = document.getElementById(`ps_${stage}ApiDisplay`);
    if (display) {
        const api = settings[`${stage}Api`] || 'N/A';
        const model = settings[`${stage}Model`] || 'Not Set';
        const displayName = api.charAt(0).toUpperCase() + api.slice(1);
        display.textContent = `${displayName} / ${model}`;
        display.title = `${displayName} / ${model}`;
    }
}

function parseUIDs(text) {
    const match = text.match(/<UIDs>(.*?)<\/UIDs>/s);
    if (!match || !match[1]) {
        log('UID tag not found in analysis response.');
        return [];
    }
    return match[1].split(',')
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n));
}


// ============================================================================
//  API & CORE FUNCTIONS
// ============================================================================

async function populateLorebookOptions() {
    log('Fetching lorebook list...');
    const selectElement = document.getElementById('ps_lorebookFile');
    if (!selectElement) return;
    try {
        const response = await fetch('/api/worldinfo/list', { method: 'POST' });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const lorebooks = await response.json();
        selectElement.innerHTML = '<option value="">-- Select a lorebook file --</option>';
        if (lorebooks && lorebooks.length > 0) {
            lorebooks.forEach(book => {
                const option = document.createElement('option');
                option.value = book.name;
                option.textContent = book.name;
                selectElement.appendChild(option);
            });
            log(`Successfully populated ${lorebooks.length} lorebooks.`);
        } else {
            log('No lorebooks found.');
        }
        selectElement.value = getSettings().lorebookFile || '';
    } catch (error) {
        log('Failed to fetch or populate lorebook list.', { error: error.message });
        selectElement.innerHTML = '<option value="">-- Error loading lorebooks --</option>';
    }
}

async function getLorebookRegistry(fileName) {
    log(`Fetching content for lorebook: "${fileName}"`);
    if (!fileName) return '[ERROR: No lorebook file selected in settings.]';
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: fileName }),
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const lorebookData = await response.json();
        const entries = lorebookData?.entries;
        if (!entries || entries.length === 0) return '[NOTICE: Selected lorebook is empty or has no entries.]';
        const registryLines = entries.map(entry => {
            const promptName = entry.comment || 'Untitled Entry';
            const firstLine = (entry.content || '').split('\n').find(line => line.trim() !== '') || '...';
            return `[UID: ${entry.uid}] ${promptName} - ${firstLine.trim()}`;
        });
        log(`Successfully built registry with ${registryLines.length} entries.`);
        return registryLines.join('\n');
    } catch (error) {
        log('Failed to fetch or process lorebook content.', { error: error.message });
        return `[CRITICAL ERROR: Failed to load content for "${fileName}". Check console.]`;
    }
}

async function showModelSelectorPopup(stage) {
    const settings = getSettings();
    const stageUpper = stage === 'stage1' ? 'Stage 1 (Analysis)' : 'Stage 2 (Generation)';
    const currentApi = settings[`${stage}Api`] || 'openai';
    const currentModel = settings[`${stage}Model`];
    const popupContent = document.createElement('div');
    popupContent.innerHTML = `
        <div style="margin-bottom: 10px;"><label for="ps-popup-api-select">API Provider:</label><select id="ps-popup-api-select" class="text_pole"></select></div>
        <div><label for="ps-popup-model-select">Model:</label><select id="ps-popup-model-select" class="text_pole"></select></div>`;
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
        if (!selectorId) return;
        const sourceSelect = document.querySelector(selectorId);
        if (sourceSelect && sourceSelect.options.length > 0) {
            Array.from(sourceSelect.options).forEach(option => {
                if (option.value) modelSelect.appendChild(option.cloneNode(true));
            });
            modelSelect.value = currentModel;
            if (!modelSelect.value && modelSelect.options.length > 0) modelSelect.selectedIndex = 0;
        } else {
            modelSelect.innerHTML = '<option value="">-- No models found --</option>';
        }
    };
    populateModels(currentApi);
    apiSelect.onchange = () => populateModels(apiSelect.value);
    if (await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, `Select Model for ${stageUpper}`)) {
        if (modelSelect.value) {
            settings[`${stage}Api`] = apiSelect.value;
            settings[`${stage}Model`] = modelSelect.value;
            saveSettings();
            updateApiDisplay(stage);
            window.toastr.success(`Model for ${stageUpper} saved.`);
            log(`Saved model for ${stage}:`, { api: apiSelect.value, model: modelSelect.value });
        } else {
            window.toastr.warning(`No model selected. Settings for ${stageUpper} remain unchanged.`, LOG_PREFIX);
        }
    }
}

function getRecentChatMessages(depth) {
    try {
        const chat = document.getElementById('chat');
        if (!chat) return 'No chat history available.';
        const messages = Array.from(chat.querySelectorAll('.mes')).slice(-depth);
        const formattedMessages = messages.map(msg => {
            const name = msg.querySelector('.ch_name')?.textContent?.trim() || 'Unknown';
            const text = msg.querySelector('.mes_text')?.textContent?.trim() || '';
            return `${name}: ${text}`;
        }).filter(Boolean);
        return formattedMessages.length > 0 ? formattedMessages.join('\n') : 'No recent messages found.';
    } catch (error) {
        log('Error getting chat messages', { error: error.message });
        return 'Error retrieving chat history.';
    }
}

function getCharacterData() {
    try {
        const context = getContext();
        if (!context || !context.characterId || !context.characters) return "No character loaded.";
        const character = context.characters[context.characterId];
        if (!character) return "Could not find character data.";
        let profile = `Name: ${character.name || 'Unnamed'}\n`;
        if (character.description) profile += `Description: ${character.description}\n`;
        if (character.personality) profile += `Personality: ${character.personality}\n`;
        return profile.trim();
    } catch (error) {
        log('Error getting character data', { error: error.message });
        return 'Error retrieving character data.';
    }
}

async function applyModelEnvironment(stage) {
    const settings = getSettings();
    let api, model;
    if (stage === 'stage2' && (!settings.stage2Api || !settings.stage2Model)) {
        api = userOriginalSettings.api;
        model = userOriginalSettings.model;
        log('Stage 2 settings are empty, using user\'s original settings.');
    } else {
        api = settings[`${stage}Api`];
        model = settings[`${stage}Model`];
    }
    if (!api || !model) throw new Error(`Missing API or Model for ${stage}. Cannot proceed.`);
    log(`Applying ${stage} environment`, { api, model });
    const commands = [`/api ${api}`, `/model "${model}"`];
    const result = await getContext().executeSlashCommandsWithOptions(commands.join(' | '), { showOutput: false, handleExecutionErrors: true });
    if (result?.isError) throw new Error(`Failed to apply ${stage} environment: ${result.errorMessage}`);
}

async function restoreUserSettings() {
    if (!userOriginalSettings.api || !userOriginalSettings.model || pipelineState.isRestoring) return;
    pipelineState.isRestoring = true;
    try {
        log('Restoring user settings...', { ...userOriginalSettings });
        const commands = [`/api ${userOriginalSettings.api}`, `/model "${userOriginalSettings.model}"`];
        await getContext().executeSlashCommandsWithOptions(commands.join(' | '), { showOutput: false, handleExecutionErrors: true });
        userOriginalSettings.api = null;
        userOriginalSettings.model = null;
        log('User settings restored successfully.');
    } catch (error) {
        log('Settings restoration failed', { error: error.message });
    } finally {
        pipelineState.isRestoring = false;
    }
}

async function applySmartRegeneration() {
    const lastMessage = document.querySelector('#chat .mes:last-child .mes_text')?.textContent || '';
    if (!lastMessage) return;
    const firstSentence = lastMessage.split(/[.!?]/)[0];
    const regenPrompt = `[System: User has requested a regeneration. Provide an alternative response. Avoid repeating the previous attempt, which started with: "${firstSentence}"]`;
    await getContext().executeSlashCommandsWithOptions(`/inject id=ps_smart_regen position=after depth=0 ${JSON.stringify(regenPrompt)}`, { showOutput: false });
    log('Smart regeneration prompt injected.');
}


// ============================================================================
//  PIPELINE ORCHESTRATION
// ============================================================================

async function handlePipelineTrigger(data) {
    const settings = getSettings();
    const eventType = data?.type || 'generate';

    if (!settings.enabled || !pipelineState.dependenciesMet || pipelineState.isRunning) {
        return true;
    }

    pipelineState.isRunning = true;
    pipelineState.lastActivity = Date.now();
    log(`Pipeline triggered for event: ${eventType}`);

    try {
        showStatusIndicator('Analyzing...');
        await restoreUserSettings();

        const context = getContext();
        userOriginalSettings.api = context.api;
        userOriginalSettings.model = context.model;
        log('Saved user settings', { ...userOriginalSettings });

        const isRegen = eventType === 'swipe' || eventType === 'regenerate';
        let uidsToActivate;

        if (isRegen && pipelineState.cachedAnalysis) {
            log('Using cached analysis for regeneration.');
            if (settings.smartRegeneration) {
                await applySmartRegeneration();
            }
            uidsToActivate = pipelineState.cachedAnalysis;
        } else {
            pipelineState.cachedAnalysis = null;
            log('Starting new analysis stage...');
            const registry = await getLorebookRegistry(settings.lorebookFile);
            if (registry.startsWith('[ERROR:') || registry.startsWith('[CRITICAL ERROR:')) {
                throw new Error(registry);
            }
            const history = getRecentChatMessages(settings.contextDepth);
            const character = getCharacterData();
            const analysisPrompt = (settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT)
                .replace('{{registry}}', registry)
                .replace('{{history}}', history)
                .replace('{{character}}', character);
            
            await applyModelEnvironment('stage1');
            const result = await context.executeSlashCommandsWithOptions(`/genraw ${JSON.stringify(analysisPrompt)}`, { showOutput: false, handleExecutionErrors: true });
            if (result?.isError) throw new Error(`Analysis failed: ${result.errorMessage}`);
            
            uidsToActivate = parseUIDs(result.pipe || '');
            pipelineState.cachedAnalysis = uidsToActivate;
            log('Analysis complete', { uids: uidsToActivate });
        }

        if (uidsToActivate.length > 0) {
            log(`Activating ${uidsToActivate.length} lorebook entries...`);
            for (const uid of uidsToActivate) {
                const script = `/wi-trigger file="${settings.lorebookFile}" uid=${uid} now=false`;
                await context.executeSlashCommandsWithOptions(script, { showOutput: false, handleExecutionErrors: true });
            }
        } else {
            log('No UIDs were selected by the analysis agent.');
        }

        showStatusIndicator('Generating response...');
        await applyModelEnvironment('stage2');
        log('Pipeline setup complete, handing over to generation.');
        return true;

    } catch (error) {
        log('Pipeline failed', { error: error.message });
        window.toastr.error(`Pipeline failed: ${error.message}`, LOG_PREFIX);
        await restoreUserSettings();
        return false;
        
    } finally {
        pipelineState.isRunning = false;
        hideStatusIndicator();
    }
}

async function runAnalysisDryRun() {
    log('Starting analysis dry run...');
    const settings = getSettings();
    if (!settings.lorebookFile) {
        window.toastr.warning('Please select a lorebook file first.', LOG_PREFIX);
        return;
    }
    window.toastr.info('Running analysis dry run...', LOG_PREFIX);
    
    const context = getContext();
    const originalApi = context.api;
    const originalModel = context.model;

    try {
        const registry = await getLorebookRegistry(settings.lorebookFile);
        if (registry.startsWith('[ERROR:') || registry.startsWith('[CRITICAL ERROR:')) throw new Error(registry);
        const history = getRecentChatMessages(settings.contextDepth);
        const character = getCharacterData();
        const analysisPrompt = (settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT)
            .replace('{{registry}}', registry)
            .replace('{{history}}', history)
            .replace('{{character}}', character);
        
        await applyModelEnvironment('stage1');
        const result = await context.executeSlashCommandsWithOptions(`/genraw ${JSON.stringify(analysisPrompt)}`, { showOutput: false, handleExecutionErrors: true });
        if (result?.isError) throw new Error(`Analysis failed: ${result.errorMessage}`);

        const uids = parseUIDs(result.pipe || '');
        const message = `Dry run complete. Analysis would activate UIDs: ${uids.join(', ') || 'None'}`;
        log(message, { uids });
        window.toastr.success(message, 'Analysis Dry Run Result');

    } catch (error) {
        log('Dry run failed', { error: error.message });
        window.toastr.error(`Dry run failed: ${error.message}`, LOG_PREFIX);
    } finally {
        await getContext().executeSlashCommandsWithOptions(`/api ${originalApi} | /model "${originalModel}"`, { showOutput: false });
        log('Dry run finished, user settings restored.');
    }
}


// ============================================================================
//  UI MANAGEMENT
// ============================================================================

function showStatusIndicator(message) {
    let indicator = document.getElementById('pipeline-status-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'pipeline-status-indicator';
        indicator.className = 'pipeline-status-indicator';
        document.body.appendChild(indicator);
    }
    indicator.textContent = `[PseudoBBL] ${message}`;
    indicator.classList.add('active');
}

function hideStatusIndicator() {
    const indicator = document.getElementById('pipeline-status-indicator');
    if (indicator) {
        indicator.classList.remove('active');
    }
}

function initializeUI() {
    const settings = getSettings();
    document.getElementById('ps_enabled').onchange = (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        updateUIState();
    };
    document.getElementById('ps_stage1SelectBtn').onclick = () => showModelSelectorPopup('stage1');
    document.getElementById('ps_stage2SelectBtn').onclick = () => showModelSelectorPopup('stage2');
    document.getElementById('ps_lorebookFile').onchange = (e) => {
        settings.lorebookFile = e.target.value;
        saveSettings();
    };
    
    const analysisPromptEl = document.getElementById('ps_analysisPrompt');
    analysisPromptEl.oninput = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            getSettings().analysisPromptTemplate = analysisPromptEl.value;
            saveSettings();
            log('Analysis prompt template saved via debounce.');
        }, 500);
    };
    
    document.getElementById('ps_resetPrompt').onclick = () => {
        analysisPromptEl.value = DEFAULT_ANALYSIS_PROMPT;
        settings.analysisPromptTemplate = DEFAULT_ANALYSIS_PROMPT;
        saveSettings();
        window.toastr.info('Analysis prompt reset to default.');
    };
    const contextDepthEl = document.getElementById('ps_contextDepth');
    const contextDepthValueEl = document.getElementById('ps_contextDepthValue');
    contextDepthEl.oninput = () => { contextDepthValueEl.textContent = contextDepthEl.value; };
    contextDepthEl.onchange = () => {
        settings.contextDepth = parseInt(contextDepthEl.value);
        saveSettings();
    };
    document.getElementById('ps_smartRegeneration').onchange = (e) => {
        settings.smartRegeneration = e.target.checked;
        saveSettings();
    };
    document.getElementById('ps_debugMode').onchange = (e) => {
        settings.debugMode = e.target.checked;
        saveSettings();
    };
    document.getElementById('ps_dryRun').onclick = runAnalysisDryRun;
    document.getElementById('ps_clearCache').onclick = () => {
        pipelineState.cachedAnalysis = null;
        window.toastr.info('Analysis cache cleared.', LOG_PREFIX);
    };
    document.getElementById('ps_showDebug').onclick = showDebugLog;
    log('UI event listeners bound.');
}

function updateUIState() {
    log('Updating UI state...');
    const settings = getSettings();
    const enableToggle = document.getElementById('ps_enabled');
    const warningDiv = document.getElementById('ps_dependency_warning');
    const container = document.getElementById('ps_pipeline_container');
    if (!pipelineState.dependenciesMet) {
        if (enableToggle) { enableToggle.checked = false; enableToggle.disabled = true; }
        if (warningDiv) warningDiv.innerHTML = '<strong>LALib extension is required. Pipeline disabled.</strong>';
        if (container) container.style.display = 'none';
        return;
    } else {
        if (enableToggle) enableToggle.disabled = false;
        if (warningDiv) warningDiv.innerHTML = '';
    }
    if (enableToggle) enableToggle.checked = settings.enabled;
    if (container) container.style.display = settings.enabled ? 'block' : 'none';
    updateApiDisplay('stage1');
    updateApiDisplay('stage2');
    const lorebookSelect = document.getElementById('ps_lorebookFile');
    if (lorebookSelect.value !== settings.lorebookFile) lorebookSelect.value = settings.lorebookFile || '';
    const analysisPromptEl = document.getElementById('ps_analysisPrompt');
    if(analysisPromptEl) analysisPromptEl.value = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
    const contextDepthEl = document.getElementById('ps_contextDepth');
    const contextDepthValueEl = document.getElementById('ps_contextDepthValue');
    if (contextDepthEl && contextDepthValueEl) {
        contextDepthEl.value = settings.contextDepth;
        contextDepthValueEl.textContent = settings.contextDepth;
    }
    const smartRegenEl = document.getElementById('ps_smartRegeneration');
    if(smartRegenEl) smartRegenEl.checked = settings.smartRegeneration;
    const debugModeEl = document.getElementById('ps_debugMode');
    if(debugModeEl) debugModeEl.checked = settings.debugMode;
}

function bindCoreEventListeners() {
    const eventToUse = event_types.GENERATE_BEFORE_COMBINE_PROMPTS || event_types.GENERATE_BEFORE;
    eventSource.makeLast(eventToUse, async (data) => {
        return await handlePipelineTrigger(data);
    });

    eventSource.on(event_types.GENERATE_AFTER, async () => {
        try {
            await restoreUserSettings();
            await getContext().executeSlashCommandsWithOptions('/inject-remove id=ps_smart_regen', { showOutput: false });
        } catch (error) {
            log('Error during post-generation cleanup.', { error: error.message });
        }
    });

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, () => log('Swipe detected, preserving cache.'));
    }
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        pipelineState.cachedAnalysis = null;
        log('Message deleted, cache cleared.');
    });
    log('Core event listeners bound.');
}


// ============================================================================
//  INITIALIZATION
// ============================================================================

async function initializeExtension() {
    log('Initializing PseudoBBL...');
    try {
        const settings = getSettings();
        if (!settings.stage2Api || !settings.stage2Model) {
            const context = getContext();
            settings.stage2Api = context.api;
            settings.stage2Model = context.model;
            saveSettings();
            log('Initialized Stage 2 model to user\'s current selection.');
        }

        const extensionBasePath = new URL('.', import.meta.url).href;
        const settingsHtml = await fetch(`${extensionBasePath}settings.html`).then(res => res.text());
        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', settingsHtml);
        
        if (!checkDependencies()) {
            window.toastr.error('LALib extension not found. PseudoBBL is disabled.', LOG_PREFIX, { timeOut: 0, extendedTimeOut: 0 });
        }
        
        initializeUI();
        bindCoreEventListeners();
        await populateLorebookOptions();
        updateUIState();
        log('PseudoBBL initialization sequence complete.');
    } catch (error) {
        console.error(`${LOG_PREFIX} Critical initialization failure:`, error);
        window.toastr.error(`PseudoBBL failed to initialize. Check console (F12).`, LOG_PREFIX);
    }
}

eventSource.on(event_types.APP_READY, () => initializeExtension());
