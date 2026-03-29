import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import 'monaco-editor/esm/vs/basic-languages/plaintext/plaintext.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/language/html/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';

declare global {
    interface Window {
        MonacoEnvironment?: {
            getWorker?: (_moduleId: string, label: string) => Worker;
        };
    }
}

window.MonacoEnvironment = {
    getWorker(_moduleId, label) {
        if (label === 'json') {
            return new jsonWorker();
        }

        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new htmlWorker();
        }

        if (label === 'typescript' || label === 'javascript') {
            return new tsWorker();
        }

        return new editorWorker();
    },
};

loader.config({ monaco });

export { monaco };