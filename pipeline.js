// pipeline.js

import { getContext } from '../../../extensions.js';
import { SillyTavern } from '../../../../SillyTavern.js';

// These utilities are used exclusively by the pipeline, so they live here.
function withTimeout(promise, timeoutMs = 30000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
        )
    ]);
}

function parseUIDs(text) {
    const match = text.match(/<UIDs>(.*?)<\/UIDs>/);
    if (!match || !match[1]) {
        // We'll let the calling function handle logging for context.
        return [];
    }
    const uidsString = match[1];
    if (uidsString.trim() === '') return [];
    return uidsString.split(',')
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n));
}

/**
 * Executes the Stage 1 analysis call.
 * @param {object} settings - The extension's settings object.
 * @param {string} analysisPrompt - The fully constructed prompt for the analysis agent.
 * @returns {Promise<number[]>} A promise that resolves to an array of UIDs.
 */
export async function runAnalysisStage(settings, analysisPrompt) {
    await applyModelEnvironment(settings, 'stage1');
    
    const result = await withTimeout(
        getContext().executeSlashCommandsWithOptions(`/genraw ${JSON.stringify(analysisPrompt)}`, {
            showOutput: false,
            handleExecutionErrors: true
        }),
        45000 // 45 second timeout for analysis
    );

    if (result?.isError) {
        throw new Error(`Analysis API call failed: ${result.errorMessage}`);
    }
    
    return parseUIDs(result.pipe || '');
}

/**
 * Activates the specified lorebook entries using /wi-trigger.
 * @param {object} settings - The extension's settings object.
 * @param {number[]} uids - An array of UIDs to activate.
 */
export async function activateLorebooks(settings, uids) {
    if (!settings.lorebookFile) {
        throw new Error('No lorebook file is configured in settings.');
    }
    if (typeof window.LALib === 'undefined') {
        window.toastr.warning('LALib extension not found. Dynamic prompts cannot be activated.', 'PseudoBBL');
        return;
    }
    for (const uid of uids) {
        const script = `/wi-trigger file="${settings.lorebookFile}" uid=${uid} now=false`;
        await getContext().executeSlashCommandsWithOptions(script, { showOutput: false, handleExecutionErrors: true });
    }
}

/**
 * Sets the API and Model for a specific pipeline stage.
 * @param {object} settings - The extension's settings object.
 * @param {string} stage - The stage to configure ('stage1' or 'stage2').
 */
export async function applyModelEnvironment(settings, stage) {
    const api = settings[`${stage}Api`];
    const model = settings[`${stage}Model`];
    const commands = [];
    if (api) commands.push(`/api ${api}`);
    if (model) commands.push(`/model "${model}"`);
    if (commands.length === 0) return;

    const result = await getContext().executeSlashCommandsWithOptions(commands.join(' | '), { showOutput: false, handleExecutionErrors: true });
    if (result?.isError) {
        throw new Error(`Failed to apply ${stage} environment: ${result.errorMessage}`);
    }
}

/**
 * Constructs the registry of prompts from the selected lorebook.
 * @param {string} lorebookFile - The filename of the selected lorebook.
 * @returns {Promise<string>} A string representing the formatted registry.
 */
export async function getLorebookRegistry(lorebookFile) {
    if (!lorebookFile) {
        return '[ERROR: No lorebook file selected in extension settings.]';
    }
    try {
        const lorebook = SillyTavern.lorebooks.find(book => book.file_name === lorebookFile);
        if (!lorebook) {
            return `[ERROR: The lorebook file "${lorebookFile}" could not be found among the loaded books.]`;
        }
        const entries = Object.values(lorebook.entries);
        if (entries.length === 0) return '[NOTICE: The selected lorebook is empty or has no entries.]';
        
        const registryLines = entries.map(entry => {
            const promptName = entry.comment || 'Untitled Prompt';
            const firstLine = entry.content.split('\n').find(line => line.trim() !== '') || 'No description.';
            return `[UID: ${entry.uid}] ${promptName} - ${firstLine.trim()}`;
        });
        return registryLines.join('\n');
    } catch (error) {
        console.error('[PseudoBBL] Failed to build lorebook registry:', error);
        return `[CRITICAL ERROR: Failed to process lorebook file. Check browser console for details.]`;
    }
}