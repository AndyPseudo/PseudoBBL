import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

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
    version: 1,
    enabled: false,
    
    // Stage 1: Analysis Agent
    stage1Preset: 'Default',
    stage1Api: 'google',
    stage1Model: 'gemini-1.5-flash-latest',
    analysisPromptTemplate: '',
    
    // Stage 2: Generation Model  
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
    const logEntry = { timestamp, message, data };
    
    pipelineState.debugLog.push(logEntry);
    if (pipelineState.debugLog.length > 100) {
        pipelineState.debugLog.shift();
    }
    
    console.log(`${LOG_PREFIX} ${message}`, data || '');
}

function showDebugLog() {
    const logContent = pipelineState.debugLog
        .map(entry => `[${entry.timestamp}] ${entry.message}` + 
             (entry.data ? `\n  Data: ${JSON.stringify(entry.data, null, 2)}` : ''))
        .reverse()
        .join('\n\n');
    
    window.toastr.info('Debug log output to console', LOG_PREFIX);
    console.log(`${LOG_PREFIX} Debug Log:\n${logContent}`);
}

// ============================================================================
// DEPENDENCY CHECKING
// ============================================================================
async function checkDependencies() {
    log('Checking dependencies...');
    
    // Check for LALib
    const hasLALib = typeof window.LALib !== 'undefined' || 
                     extension_settings.LALib !== undefined;
    
    if (!hasLALib) {
        log('LALib not found - will use fallback methods');
        window.toastr.warning(
            'LALib extension recommended for full functionality',
            LOG_PREFIX
        );
        return false;
    }
    
    log('All dependencies satisfied');
    return true;
}

// ============================================================================
// LOREBOOK REGISTRY MANAGEMENT
// ============================================================================
function getLorebookRegistry() {
    const settings = extension_settings[EXTENSION_NAME];
    
    // This will be populated from the selected lorebook file
    // For now, return a sample registry
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
        // Get recent messages
        const recentMessages = getRecentChatMessages(settings.contextDepth);
        
        // Build analysis prompt
        let analysisPrompt = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
        analysisPrompt = analysisPrompt
            .replace('{{registry}}', getLorebookRegistry())
            .replace('{{history}}', recentMessages);
        
        // Apply Stage 1 environment
        await applyModelEnvironment('stage1');
        
        // Execute analysis generation
        const script = `/genraw ${JSON.stringify(analysisPrompt)}`;
        const result = await getContext().executeSlashCommandsWithOptions(script, {
            showOutput: false,
            handleExecutionErrors: true
        });
        
        if (result?.isError) {
            throw new Error(`Analysis failed: ${result.errorMessage}`);
        }
        
        // Parse UIDs from response
        const uidString = result.pipe || '';
        const uids = parseUIDs(uidString);
        
        log('Analysis complete', { uids });
        return uids;
        
    } catch (error) {
        log('Analysis stage error', { error: error.message });
        throw error;
    }
}

async function activateLorebooks(uids) {
    const settings = extension_settings[EXTENSION_NAME];
    log('Activating lorebook entries', { uids });
    
    if (!settings.lorebookFile) {
        log('No lorebook file configured');
        return;
    }
    
    try {
        // Use LALib if available, otherwise fallback
        const hasLALib = typeof window.LALib !== 'undefined';
        
        for (const uid of uids) {
            if (hasLALib) {
                const script = `/wi-trigger file="${settings.lorebookFile}" uid=${uid} now=false`;
                await getContext().executeSlashCommandsWithOptions(script, {
                    showOutput: false,
                    handleExecutionErrors: true
                });
            } else {
                // Fallback: manually inject prompts (requires setup)
                log('LALib not available - skipping lorebook activation');
            }
        }
        
        log('Lorebook activation complete');
    } catch (error) {
        log('Lorebook activation error', { error: error.message });
        throw error;
    }
}

async function runGenerationStage() {
    const settings = extension_settings[EXTENSION_NAME];
    log('Starting generation stage...');
    
    try {
        // Apply Stage 2 environment
        await applyModelEnvironment('stage2');
        
        // Trigger normal generation
        await getContext().executeSlashCommandsWithOptions('/trigger', {
            showOutput: false,
            handleExecutionErrors: true
        });
        
        log('Generation stage complete');
    } catch (error) {
        log('Generation stage error', { error: error.message });
        throw error;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function getRecentChatMessages(depth) {
    const chatDiv = document.getElementById('chat');
    if (!chatDiv) return '';
    
    const messages = Array.from(chatDiv.querySelectorAll('.mes'))
        .slice(-depth)
        .map(msg => {
            const name = msg.querySelector('.ch_name')?.textContent || 'Unknown';
            const text = msg.querySelector('.mes_text')?.textContent || '';
            return `${name}: ${text}`;
        })
        .join('\n');
    
    return messages;
}

function parseUIDs(text) {
    // Extract comma-separated numbers
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
    
    log(`Applying ${stage} environment`, { preset, api, model });
    
    const commands = [];
    
    if (preset && preset !== 'Default') {
        commands.push(`/preset "${preset}"`);
    }
    
    if (api) {
        commands.push(`/api ${api}`);
    }
    
    if (model) {
        commands.push(`/model "${model}"`);
    }
    
    if (commands.length === 0) return;
    
    const script = commands.join(' | ');
    const result = await getContext().executeSlashCommandsWithOptions(script, {
        showOutput: false,
        handleExecutionErrors: true
    });
    
    if (result?.isError) {
        throw new Error(`Failed to apply ${stage} environment: ${result.errorMessage}`);
    }
}

// ============================================================================
// MAIN PIPELINE HANDLER
// ============================================================================
async function handlePipelineTrigger(messageId, eventType) {
    const settings = extension_settings[EXTENSION_NAME];
    
    // Check if we should skip (disabled or already running)
    if (!settings.enabled) {
        return false; // Let normal generation proceed
    }
    
    if (pipelineState.isRunning) {
        log('Pipeline already running, skipping');
        return false;
    }
    
    // Check if shift key is held for bypass
    if (window.event && window.event.shiftKey) {
        log('Pipeline bypassed with Shift key');
        window.toastr.info('Pipeline bypassed (Shift held)', LOG_PREFIX);
        return false;
    }
    
    log('Pipeline triggered', { messageId, eventType });
    pipelineState.isRunning = true;
    
    // Show status indicator if available
    showStatusIndicator('Analyzing...');
    
    try {
        const isRegeneration = eventType === 'swipe' || eventType === 'regenerate';
        let uidsToActivate = [];
        
        // Stage 1: Analysis (or use cache)
        if (isRegeneration && pipelineState.cachedAnalysis) {
            log('Using cached analysis for regeneration');
            uidsToActivate = pipelineState.cachedAnalysis;
            
            // Apply smart regeneration if enabled
            if (settings.smartRegeneration) {
                showStatusIndicator('Applying smart regeneration...');
                await applySmartRegeneration();
            }
        } else {
            showStatusIndicator('Running analysis...');
            uidsToActivate = await runAnalysisStage();
            pipelineState.cachedAnalysis = uidsToActivate;
            pipelineState.lastAnalysisTime = Date.now();
        }
        
        // Activate lorebooks
        if (uidsToActivate.length > 0) {
            showStatusIndicator('Activating prompts...');
            await activateLorebooks(uidsToActivate);
        }
        
        // Stage 2: Generation will proceed naturally
        showStatusIndicator('Generating response...');
        log('Pipeline setup complete, generation will proceed');
        
        // Add indicator to show which UIDs were used
        if (settings.debugMode) {
            window.toastr.info(`Active UIDs: ${uidsToActivate.join(', ')}`, LOG_PREFIX);
        }
        
        hideStatusIndicator();
        return true; // Pipeline handled successfully
        
    } catch (error) {
        log('Pipeline failed', { error: error.message });
        window.toastr.error(`Pipeline failed: ${error.message}`, LOG_PREFIX);
        hideStatusIndicator();
        return false; // Let normal generation proceed as fallback
        
    } finally {
        pipelineState.isRunning = false;
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
    if (indicator) {
        indicator.classList.remove('active');
    }
}

async function applySmartRegeneration() {
    log('Applying smart regeneration prompt');
    
    // Get last bot message
    const lastMessage = document.querySelector('.mes:last-child .mes_text')?.textContent || '';
    const firstSentence = lastMessage.split(/[.!?]/)[0];
    
    const regenPrompt = `[User regenerated. Generate an alternative response with a different opening and narrative direction. Avoid: "${firstSentence}"]`;
    
    // Inject as hidden system message
    const script = `/inject id=smart_regen position=chat depth=0 role=system ${JSON.stringify(regenPrompt)}`;
    
    await getContext().executeSlashCommandsWithOptions(script, {
        showOutput: false,
        handleExecutionErrors: true
    });
}

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initializeExtension() {
    log('Initializing Pipeline Scheduler...');
    
    try {
        // Initialize settings
        extension_settings[EXTENSION_NAME] = {
            ...defaultSettings,
            ...extension_settings[EXTENSION_NAME]
        };
        
        // Check dependencies
        await checkDependencies();
        
        // Load UI
        const settingsHtml = await fetch(`${EXTENSION_FOLDER_PATH}/settings.html`)
            .then(res => res.text());
        
        document.getElementById('extensions_settings')
            .insertAdjacentHTML('beforeend', settingsHtml);
        
        // Initialize UI handlers
        initializeUI();
        
        // Register event handlers
        // We need to intercept BEFORE generation happens
        eventSource.makeLast(event_types.GENERATE_BEFORE, async (data) => {
            const shouldProceed = await handlePipelineTrigger(null, 'generate');
            if (!shouldProceed) {
                // Clear cache for new messages (not regenerations)
                pipelineState.cachedAnalysis = null;
            }
        });
        
        // Handle regenerations/swipes separately
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, (msgId) => {
                // Don't clear cache on swipe - we want to reuse analysis
                log('Swipe detected, cache preserved');
            });
        }
        
        // Clear cache on message deletion
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            pipelineState.cachedAnalysis = null;
            log('Message deleted, cache cleared');
        });
        
        pipelineState.isReady = true;
        log('Pipeline Scheduler initialized successfully');
        window.toastr.success('Pipeline Scheduler ready', LOG_PREFIX);
        
    } catch (error) {
        log('Initialization failed', { error: error.message });
        window.toastr.error(`Failed to initialize: ${error.message}`, LOG_PREFIX);
    }
}

function initializeUI() {
    const settings = extension_settings[EXTENSION_NAME];
    
    // Master toggle
    const enableToggle = document.getElementById('ps_enabled');
    const pipelineContainer = document.getElementById('ps_pipeline_container');
    
    if (enableToggle) {
        enableToggle.checked = settings.enabled;
        enableToggle.onchange = () => {
            settings.enabled = enableToggle.checked;
            saveSettingsDebounced();
            log(`Pipeline ${settings.enabled ? 'enabled' : 'disabled'}`);
            pipelineContainer.style.display = settings.enabled ? 'block' : 'none';
        };
    }
    
    // Show/hide container based on enabled state
    if (pipelineContainer) {
        pipelineContainer.style.display = settings.enabled ? 'block' : 'none';
    }
    
    // Stage 1 Configuration
    const stage1Preset = document.getElementById('ps_stage1Preset');
    const stage1Api = document.getElementById('ps_stage1Api');
    const stage1Model = document.getElementById('ps_stage1Model');
    
    if (stage1Preset) {
        populatePresetOptions(stage1Preset);
        stage1Preset.value = settings.stage1Preset;
        stage1Preset.onchange = () => {
            settings.stage1Preset = stage1Preset.value;
            saveSettingsDebounced();
        };
    }
    
    if (stage1Api) {
        populateApiOptions(stage1Api);
        stage1Api.value = settings.stage1Api;
        stage1Api.onchange = () => {
            settings.stage1Api = stage1Api.value;
            saveSettingsDebounced();
        };
    }
    
    if (stage1Model) {
        stage1Model.value = settings.stage1Model;
        stage1Model.oninput = () => {
            settings.stage1Model = stage1Model.value;
            saveSettingsDebounced();
        };
    }
    
    // Stage 2 Configuration  
    const stage2Preset = document.getElementById('ps_stage2Preset');
    const stage2Api = document.getElementById('ps_stage2Api');
    const stage2Model = document.getElementById('ps_stage2Model');
    
    if (stage2Preset) {
        populatePresetOptions(stage2Preset);
        stage2Preset.value = settings.stage2Preset;
        stage2Preset.onchange = () => {
            settings.stage2Preset = stage2Preset.value;
            saveSettingsDebounced();
        };
    }
    
    if (stage2Api) {
        populateApiOptions(stage2Api);
        stage2Api.value = settings.stage2Api;
        stage2Api.onchange = () => {
            settings.stage2Api = stage2Api.value;
            saveSettingsDebounced();
        };
    }
    
    if (stage2Model) {
        stage2Model.value = settings.stage2Model;
        stage2Model.oninput = () => {
            settings.stage2Model = stage2Model.value;
            saveSettingsDebounced();
        };
    }
    
    // Lorebook Selection
    const lorebookSelect = document.getElementById('ps_lorebookFile');
    if (lorebookSelect) {
        populateLorebookOptions(lorebookSelect);
        lorebookSelect.value = settings.lorebookFile;
        lorebookSelect.onchange = () => {
            settings.lorebookFile = lorebookSelect.value;
            saveSettingsDebounced();
        };
    }
    
    // Analysis Prompt Template
    const analysisPrompt = document.getElementById('ps_analysisPrompt');
    const resetPromptBtn = document.getElementById('ps_resetPrompt');
    
    if (analysisPrompt) {
        analysisPrompt.value = settings.analysisPromptTemplate || DEFAULT_ANALYSIS_PROMPT;
        analysisPrompt.oninput = () => {
            settings.analysisPromptTemplate = analysisPrompt.value;
            saveSettingsDebounced();
        };
    }
    
    if (resetPromptBtn) {
        resetPromptBtn.onclick = () => {
            analysisPrompt.value = DEFAULT_ANALYSIS_PROMPT;
            settings.analysisPromptTemplate = DEFAULT_ANALYSIS_PROMPT;
            saveSettingsDebounced();
        };
    }
    
    // Advanced Settings
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
    
    const smartRegen = document.getElementById('ps_smartRegeneration');
    if (smartRegen) {
        smartRegen.checked = settings.smartRegeneration;
        smartRegen.onchange = () => {
            settings.smartRegeneration = smartRegen.checked;
            saveSettingsDebounced();
        };
    }
    
    const debugMode = document.getElementById('ps_debugMode');
    if (debugMode) {
        debugMode.checked = settings.debugMode;
        debugMode.onchange = () => {
            settings.debugMode = debugMode.checked;
            saveSettingsDebounced();
        };
    }
    
    // Action Buttons
    const dryRunBtn = document.getElementById('ps_dryRun');
    if (dryRunBtn) {
        dryRunBtn.onclick = runAnalysisDryRun;
    }
    
    const clearCacheBtn = document.getElementById('ps_clearCache');
    if (clearCacheBtn) {
        clearCacheBtn.onclick = () => {
            pipelineState.cachedAnalysis = null;
            log('Analysis cache cleared');
            window.toastr.info('Analysis cache cleared', LOG_PREFIX);
        };
    }
    
    const showDebugBtn = document.getElementById('ps_showDebug');
    if (showDebugBtn) {
        showDebugBtn.onclick = showDebugLog;
    }
    
    log('UI initialized');
}

async function populatePresetOptions(selectElement) {
    try {
        // Wait for OpenAI settings to be available
        const { openai_setting_names } = await import('../../../../scripts/openai.js');
        
        if (openai_setting_names && Object.keys(openai_setting_names).length > 0) {
            selectElement.innerHTML = '<option value="Default">Default</option>';
            Object.keys(openai_setting_names).forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                selectElement.appendChild(option);
            });
        }
    } catch (error) {
        log('Failed to load presets', { error: error.message });
    }
}

async function populateLorebookOptions(selectElement) {
    try {
        // Get lorebook files from the world info manager
        const worldInfoFiles = document.querySelectorAll('#world_editor_select option');
        
        selectElement.innerHTML = '<option value="">-- Select a lorebook file --</option>';
        worldInfoFiles.forEach(option => {
            if (option.value) {
                const newOption = document.createElement('option');
                newOption.value = option.value;
                newOption.textContent = option.textContent;
                selectElement.appendChild(newOption);
            }
        });
    } catch (error) {
        log('Failed to load lorebook files', { error: error.message });
    }
}

async function runAnalysisDryRun() {
    log('Running analysis dry run...');
    window.toastr.info('Running analysis dry run...', LOG_PREFIX);
    
    try {
        const uids = await runAnalysisStage();
        
        const message = `Analysis would activate UIDs: ${uids.join(', ') || 'None'}`;
        log('Dry run complete', { uids });
        window.toastr.success(message, 'Analysis Dry Run');
        
        // Also show in a popup for clarity
        const popupContent = document.createElement('div');
        popupContent.innerHTML = `
            <h4>Analysis Dry Run Results</h4>
            <p><strong>Selected UIDs:</strong> ${uids.join(', ') || 'None'}</p>
            <p><strong>Context Depth:</strong> ${extension_settings[EXTENSION_NAME].contextDepth} messages</p>
            <p>These lorebook entries would be activated for the next generation.</p>
        `;
        
        // If callGenericPopup is available, use it
        if (typeof callGenericPopup !== 'undefined') {
            const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
            callGenericPopup(popupContent, POPUP_TYPE.DISPLAY, 'Dry Run Results');
        }
        
    } catch (error) {
        log('Dry run failed', { error: error.message });
        window.toastr.error(`Dry run failed: ${error.message}`, LOG_PREFIX);
    }
}

function populateApiOptions(selectElement) {
    const context = getContext();
    if (!context || !context.completion_providers) {
        log('Completion providers not available to populate API list.');
        return;
    }

    const currentValue = selectElement.value;
    selectElement.innerHTML = '';

    context.completion_providers.forEach(provider => {
        if (provider.type === 'echo') return; // Exclude echo provider
        const option = document.createElement('option');
        option.value = provider.type;
        option.textContent = provider.name;
        selectElement.appendChild(option);
    });
    
    if ([...selectElement.options].some(opt => opt.value === currentValue)) {
        selectElement.value = currentValue;
    } else if (selectElement.options.length > 0) {
        selectElement.value = selectElement.options[0].value;
    }
}

// ============================================================================
// EXTENSION ENTRY POINT
// ============================================================================
eventSource.on(event_types.APP_READY, () => {
    log('App ready, initializing extension...');
    setTimeout(initializeExtension, 100);
});
