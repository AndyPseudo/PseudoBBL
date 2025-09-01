import { getContext } from '../../../extensions.js';
import { SillyTavern } from '../../../../SillyTavern.js';

function withTimeout(promise, timeoutMs = 45000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
        )
    ]);
}

function parseUIDs(text) {
    const match = text.match(/<UIDs>(.*?)<\/UIDs>/);
    if (!match || !match[1]) return [];
    const uidsString = match[1];
    if (uidsString.trim() === '') return [];
    return uidsString.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
}

export async function runAnalysisStage(settings, analysisPrompt) {
    await applyModelEnvironment(settings, 'stage1');
    const result = await withTimeout(
        getContext().executeSlashCommandsWithOptions(`/genraw ${JSON.stringify(analysisPrompt)}`, {
            showOutput: false,
            handleExecutionErrors: true
        })
    );
    if (result?.isError) throw new Error(`Analysis API call failed: ${result.errorMessage}`);
    return parseUIDs(result.pipe || '');
}

export async function activateLorebooks(settings, uids) {
    if (!settings.lorebookFile) throw new Error('No lorebook file is configured in settings.');
    if (typeof window.LALib === 'undefined') {
        window.toastr.warning('LALib extension not found. Dynamic prompts cannot be activated.', 'PseudoBBL');
        return;
    }
    for (const uid of uids) {
        const script = `/wi-trigger file="${settings.lorebookFile}" uid=${uid} now=false`;
        await getContext().executeSlashCommandsWithOptions(script, { showOutput: false, handleExecutionErrors: true });
    }
}

export async function applyModelEnvironment(settings, stage) {
    const api = settings[`${stage}Api`];
    const model = settings[`${stage}Model`];
    const commands = [];
    if (api) commands.push(`/api ${api}`);
    if (model) commands.push(`/model "${model}"`);
    if (commands.length === 0) return;
    const result = await getContext().executeSlashCommandsWithOptions(commands.join(' | '), { showOutput: false, handleExecutionErrors: true });
    if (result?.isError) throw new Error(`Failed to apply ${stage} environment: ${result.errorMessage}`);
}

export async function getLorebookRegistry(lorebookFile) {
    if (!lorebookFile) return '[ERROR: No lorebook file selected in extension settings.]';
    try {
        const lorebook = SillyTavern.lorebooks.find(book => book.file_name === lorebookFile);
        if (!lorebook) return `[ERROR: The lorebook file "${lorebookFile}" could not be found.]`;
        const entries = Object.values(lorebook.entries);
        if (entries.length === 0) return '[NOTICE: The selected lorebook is empty.]';
        const registryLines = entries.map(entry => {
            const promptName = entry.comment || 'Untitled Prompt';
            const firstLine = entry.content.split('\n').find(line => line.trim() !== '') || 'No description.';
            return `[UID: ${entry.uid}] ${promptName} - ${firstLine.trim()}`;
        });
        return registryLines.join('\n');
    } catch (error) {
        console.error('[PseudoBBL] Failed to build lorebook registry:', error);
        return `[CRITICAL ERROR: Failed to process lorebook file. Check console for details.]`;
    }
}
