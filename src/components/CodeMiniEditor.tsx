import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { ENV_AUTOCOMPLETE_MIN_LENGTH } from '../constants';
import { getEnvironmentAutocompleteContext, getEnvironmentInterpolationMatches, getEnvironmentSuggestions, resolveEnvironmentValue, stringifyEnvironmentValue } from '../utils/environment';
import { monaco } from './monaco-runtime';

let themeConfigured = false;

function ensureTheme(instance: typeof monaco) {
    if (themeConfigured) {
        return;
    }

    instance.editor.defineTheme('requii-retro-mini', {
        base: 'vs',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '7A6A55' },
            { token: 'string', foreground: '6B7E55' },
            { token: 'number', foreground: '9E613E' },
            { token: 'keyword', foreground: '6B5C43' },
        ],
        colors: {
            'editor.background': '#D7C29F',
            'editor.foreground': '#18211B',
            'editor.lineHighlightBackground': '#CBB38D',
            'editorLineNumber.foreground': '#755F45',
            'editorLineNumber.activeForeground': '#18211B',
            'editor.selectionBackground': '#B89A7288',
            'editor.inactiveSelectionBackground': '#C6AE8966',
            'editorCursor.foreground': '#18211B',
            'editorIndentGuide.background1': '#B99E77',
            'editorWidget.background': '#CFB792',
            'editorWidget.border': '#8D7557',
        },
    });

    themeConfigured = true;
}

type CodeMiniEditorProps = {
    value: string;
    onChange: (value: string) => void;
    modelPath?: string;
    language?: string;
    height?: number | string;
    placeholder?: string;
    variableNames?: string[];
    variableValues?: Record<string, unknown>;
    readOnly?: boolean;
    fillContainer?: boolean;
    headerActions?: ReactNode;
};

export function CodeMiniEditor({ value, onChange, modelPath, language = 'plaintext', height = 280, placeholder = '', variableNames = [], variableValues = {}, readOnly = false, fillContainer = false, headerActions = null }: CodeMiniEditorProps) {
    const [isFocused, setIsFocused] = useState(false);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof monaco | null>(null);
    const onChangeRef = useRef(onChange);
    const latestLocalValueRef = useRef(value || '');
    const completionDisposableRef = useRef<monaco.IDisposable | null>(null);
    const hoverDisposableRef = useRef<monaco.IDisposable | null>(null);
    const contentChangeDisposableRef = useRef<monaco.IDisposable | null>(null);
    const decorationIdsRef = useRef<string[]>([]);
    const variableNamesRef = useRef(variableNames);
    const variableValuesRef = useRef(variableValues);
    const isApplyingExternalValueRef = useRef(false);

    useEffect(
        () => () => {
            if (editorRef.current) {
                decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []);
            }
            completionDisposableRef.current?.dispose();
            hoverDisposableRef.current?.dispose();
            contentChangeDisposableRef.current?.dispose();
        },
        [],
    );

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        variableNamesRef.current = variableNames;
    }, [variableNames]);

    useEffect(() => {
        variableValuesRef.current = variableValues;
    }, [variableValues]);

    const options = useMemo(
        () => ({
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on' as const,
            lineNumbers: 'on' as const,
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: false,
            fontSize: 12,
            fontFamily: 'Consolas, "Cascadia Code", monospace',
            fontLigatures: true,
            tabSize: 2,
            insertSpaces: true,
            padding: { top: 12, bottom: 12 },
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            renderLineHighlight: 'line' as const,
            quickSuggestions: {
                other: true,
                comments: false,
                strings: true,
            },
            suggestOnTriggerCharacters: true,
            scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
            },
            readOnly,
            domReadOnly: readOnly,
        }),
        [readOnly],
    );

    const beforeMount: BeforeMount = (instance) => {
        ensureTheme(instance as typeof monaco);
    };

    function updateEnvironmentDecorations(editor: monaco.editor.IStandaloneCodeEditor, instance: typeof monaco) {
        const model = editor.getModel();
        if (!model) {
            decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
            return;
        }

        const matches = getEnvironmentInterpolationMatches(model.getValue(), variableValuesRef.current);
        decorationIdsRef.current = editor.deltaDecorations(
            decorationIdsRef.current,
            matches.map((match) => {
                const startPosition = model.getPositionAt(match.start);
                const endPosition = model.getPositionAt(match.end);
                return {
                    range: new instance.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column),
                    options: {
                        inlineClassName: match.found ? 'env-inline-token-found' : 'env-inline-token-missing',
                    },
                };
            }),
        );
    }

    useEffect(() => {
        if (!editorRef.current) {
            return;
        }

        if (!monacoRef.current) {
            return;
        }

        updateEnvironmentDecorations(editorRef.current, monacoRef.current);
    }, [value, variableValues]);

    useEffect(() => {
        const editor = editorRef.current;
        const instance = monacoRef.current;
        const model = editor?.getModel();
        if (!editor || !instance || !model) {
            return;
        }

        const nextValue = value || '';
        const currentValue = model.getValue();
        if (currentValue === nextValue) {
            latestLocalValueRef.current = nextValue;
            return;
        }

        // React state can lag behind Monaco by one render while typing.
        // Ignore those stale prop writes so they don't rewind the cursor.
        if (editor.hasTextFocus() && latestLocalValueRef.current !== nextValue) {
            return;
        }

        const hadTextFocus = editor.hasTextFocus();
        const viewState = editor.saveViewState();

        isApplyingExternalValueRef.current = true;
        try {
            model.pushEditOperations(
                [],
                [
                    {
                        range: model.getFullModelRange(),
                        text: nextValue,
                    },
                ],
                () => null,
            );
            latestLocalValueRef.current = nextValue;
        } finally {
            isApplyingExternalValueRef.current = false;
        }

        if (viewState) {
            editor.restoreViewState(viewState);
        }

        if (hadTextFocus) {
            editor.focus();
        }

        updateEnvironmentDecorations(editor, instance);
    }, [value]);

    const onMount: OnMount = (editor, instance) => {
        editorRef.current = editor;
        monacoRef.current = instance as typeof monaco;
        editor.onDidFocusEditorText(() => setIsFocused(true));
        editor.onDidBlurEditorText(() => setIsFocused(false));
        updateEnvironmentDecorations(editor, instance as typeof monaco);

        contentChangeDisposableRef.current?.dispose();
        contentChangeDisposableRef.current = editor.onDidChangeModelContent(() => {
            const model = editor.getModel();
            if (!model) {
                return;
            }

            latestLocalValueRef.current = model.getValue();

            updateEnvironmentDecorations(editor, instance as typeof monaco);
            if (isApplyingExternalValueRef.current) {
                return;
            }

            onChangeRef.current(model.getValue());
        });

        completionDisposableRef.current?.dispose();
        completionDisposableRef.current = instance.languages.registerCompletionItemProvider(language, {
            triggerCharacters: ['{', '_', '.'],
            provideCompletionItems(model, position, providerContext) {
                if (editor.getModel() !== model) {
                    return { suggestions: [] };
                }

                const modelValue = model.getValue();
                const cursorOffset = model.getOffsetAt(position);
                const forceOpen = providerContext.triggerKind === instance.languages.CompletionTriggerKind.Invoke;
                const autocompleteContext = getEnvironmentAutocompleteContext(modelValue, cursorOffset, forceOpen);

                if (!autocompleteContext) {
                    return { suggestions: [] };
                }

                if (!forceOpen && autocompleteContext.query.length < ENV_AUTOCOMPLETE_MIN_LENGTH) {
                    return { suggestions: [] };
                }

                const suggestions = getEnvironmentSuggestions(variableNamesRef.current, autocompleteContext.query).map((suggestion) => {
                    const startPosition = model.getPositionAt(autocompleteContext.replaceStart);
                    const endPosition = model.getPositionAt(autocompleteContext.replaceEnd);
                    const range = new instance.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column);
                    const resolvedValue = resolveEnvironmentValue(variableValuesRef.current, suggestion);
                    const found = resolvedValue !== undefined;
                    const previewValue = found ? stringifyEnvironmentValue(resolvedValue) : 'Variable not found in the active environment.';
                    const insertText = autocompleteContext.mode === 'inside-braces' ? suggestion : `{{${suggestion}}}`;

                    return {
                        label: suggestion,
                        kind: instance.languages.CompletionItemKind.Variable,
                        insertText,
                        range,
                        detail: found ? 'Environment variable' : 'Environment variable (missing)',
                        documentation: {
                            value: found ? `Current value:\n\n${previewValue || '(empty string)'}` : previewValue,
                        },
                    };
                });

                return { suggestions };
            },
        });

        hoverDisposableRef.current?.dispose();
        hoverDisposableRef.current = instance.languages.registerHoverProvider(language, {
            provideHover(model, position) {
                if (editor.getModel() !== model) {
                    return null;
                }

                const modelValue = model.getValue();
                const offset = model.getOffsetAt(position);
                const matches = getEnvironmentInterpolationMatches(modelValue, variableValuesRef.current);
                const activeMatch = matches.find((match) => offset >= match.start && offset <= match.end);

                if (!activeMatch) {
                    return null;
                }

                const startPosition = model.getPositionAt(activeMatch.start);
                const endPosition = model.getPositionAt(activeMatch.end);

                return {
                    range: new instance.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column),
                    contents: [
                        { value: `**${activeMatch.variableName}**` },
                        {
                            value: activeMatch.found
                                ? `Current value:\n\n\`\`\`text\n${activeMatch.resolvedValue || '(empty string)'}\n\`\`\``
                                : 'Variable not found in the active environment.',
                        },
                    ],
                };
            },
        });
    };

    return (
        <div className={`code-mini-editor relative min-w-0 rounded-xl border border-black/12 bg-[#d7c29f] shadow-[inset_0_1px_0_rgba(255,244,220,0.08)] ${fillContainer ? 'flex h-full min-h-0 flex-col' : ''} ${readOnly ? 'code-mini-editor--readonly overflow-hidden' : 'overflow-visible'}`}>
            <div className="code-mini-editor__header flex items-center justify-between border-b border-black/10 bg-[#baa07a] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink/55">
                <span>{language === 'json' ? 'JSON' : 'Text'} Editor</span>
                <div className="flex items-center gap-2">
                    {headerActions}
                    <span>{readOnly ? 'Read Only' : 'Monaco'}</span>
                </div>
            </div>
            {!value && placeholder && !isFocused ? <div className="pointer-events-none absolute left-12 right-4 top-[46px] z-[2] whitespace-pre-wrap break-words text-xs text-ink/35">{placeholder}</div> : null}
            <div className={`code-mini-editor__body min-w-0 ${fillContainer ? 'min-h-0 flex-1' : ''}`}>
                <Editor
                    beforeMount={beforeMount}
                    theme="requii-retro-mini"
                    path={modelPath}
                    language={language}
                    defaultValue={value}
                    height={fillContainer ? '100%' : height}
                    options={options}
                    onMount={onMount}
                />
            </div>
        </div>
    );
}