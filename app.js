// ===== Firebase Configuration =====
const firebaseConfig = {
    apiKey: "AIzaSyBGdQQ-p-IDYGfGvkDldETTCfFNdvdr81Q",
    authDomain: "abuchat-4b8d6.firebaseapp.com",
    databaseURL: "https://abuchat-4b8d6-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "abuchat-4b8d6",
    storageBucket: "abuchat-4b8d6.firebasestorage.app",
    messagingSenderId: "1090779434007",
    appId: "1:1090779434007:web:fb16b505863a1971196052",
    measurementId: "G-8BTHSWFLMY"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

// References
const auth = firebase.auth();
const db = firebase.database();

// ===== State Management =====
let currentUser = null; // Stores { uid, email, username }
let currentProject = null;
let currentFile = null;
let files = {};
let projectUsers = {};
let isUpdatingFromFirebase = false;

// Realtime listeners (to unsubscribe later)
let filesRef = null;
let presenceRef = null;
let projectPresenceRef = null;

// ===== Initialize App =====
document.addEventListener('DOMContentLoaded', () => {
    setupAuthListeners();

    // Auth State Observer
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            // User is signed in.
            console.log("Auth State: Signed In", user.email);
            try {
                // Fetch extra user details (username) from DB
                const snapshot = await db.ref(`users/${user.uid}`).once('value');
                const userData = snapshot.val();

                currentUser = {
                    uid: user.uid,
                    email: user.email,
                    username: userData ? userData.username : user.email.split('@')[0] // Fallback
                };

                showMainApp();
            } catch (error) {
                console.error("Error fetching user profile:", error);
                // Even if DB fails, let them in with email as username
                currentUser = { uid: user.uid, email: user.email, username: user.email.split('@')[0] };
                showMainApp();
            }
        } else {
            // User is signed out.
            console.log("Auth State: Signed Out");
            showAuthScreen();
        }
    });
});

// ===== Authentication UI Logic =====
function setupAuthListeners() {
    // Auth tabs
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
            e.target.classList.add('active');
            const formId = e.target.dataset.tab === 'login' ? 'loginForm' : 'registerForm';
            document.getElementById(formId).classList.add('active');
        });
    });

    // Login
    document.getElementById('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        auth.signInWithEmailAndPassword(email, password)
            .then(() => {
                showToast('Inicio de sesión exitoso', 'success');
            })
            .catch((error) => {
                console.error(error);
                showToast(error.message, 'error');
            });
    });

    // Register
    document.getElementById('registerForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('registerUsername').value.trim();
        const email = document.getElementById('registerEmail').value.trim();
        const password = document.getElementById('registerPassword').value;

        if (password.length < 6) return showToast('Contraseña mín. 6 caracteres', 'warning');

        auth.createUserWithEmailAndPassword(email, password)
            .then((userCredential) => {
                // Save username to DB
                const user = userCredential.user;
                return db.ref(`users/${user.uid}`).set({
                    username: username,
                    email: email,
                    createdAt: firebase.database.ServerValue.TIMESTAMP
                });
            })
            .then(() => {
                showToast('¡Cuenta creada!', 'success');
            })
            .catch((error) => {
                console.error(error);
                showToast(error.message, 'error');
            });
    });

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', () => {
        auth.signOut();
    });
}

function showAuthScreen() {
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    currentUser = null;
    currentProject = null;
    files = {};
    detachListeners();
}

function showMainApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    document.getElementById('currentUsername').textContent = currentUser.username;

    setupMainAppListeners();
    loadUserProjects();

    // Check if there was a previous project open
    const lastProject = localStorage.getItem('currentProject');
    if (lastProject) {
        loadProject(lastProject);
    }
}

// ===== Main App Logic =====
let listenersSet = false;
function setupMainAppListeners() {
    if (listenersSet) return; // Prevent double binding
    listenersSet = true;

    // Modals
    const bindModal = (btnId, modalId, closeIds) => {
        const btn = document.getElementById(btnId);
        if (btn) btn.addEventListener('click', () => {
            document.getElementById(modalId).classList.add('show');
            if (modalId === 'projectsModal') renderProjectsList();
            if (modalId === 'newProjectModal') document.getElementById('projectNameInput').focus();
            if (modalId === 'newFileModal') document.getElementById('fileNameInput').focus();
        });
        closeIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', () => {
                document.getElementById(modalId).classList.remove('show');
            });
        });
    };

    bindModal('projectsBtn', 'projectsModal', ['closeProjectsModalBtn']);
    bindModal('newProjectBtn', 'newProjectModal', ['closeNewProjectModalBtn', 'cancelNewProjectBtn']);
    bindModal('newFileBtn', 'newFileModal', ['closeModalBtn', 'cancelNewFileBtn']);
    bindModal('shareBtn', 'shareModal', ['closeShareModalBtn', 'cancelShareBtn']);

    document.getElementById('createProjectBtn').addEventListener('click', createProject);
    document.getElementById('createFileBtn').addEventListener('click', createFile);
    document.getElementById('addShareBtn').addEventListener('click', shareProject);
    document.getElementById('deleteFileBtn').addEventListener('click', deleteCurrentFile);
    document.getElementById('formatBtn').addEventListener('click', formatCode);

    document.getElementById('refreshPreviewBtn').addEventListener('click', () => {
        updatePreview();
        showToast('Vista previa actualizada', 'info');
    });

    document.getElementById('openInNewTabBtn').addEventListener('click', () => {
        if (currentProject) {
            const url = `https://collab.logise1123.workers.dev/view/${currentProject}/index.html`;
            window.open(url, '_blank');
        } else {
            showToast('Abre un proyecto primero', 'warning');
        }
    });

    // Editor Logic
    // Handled mainly by window.initMonacoEditor now

    // Format Button
    document.getElementById('formatBtn').addEventListener('click', () => {
        if (monacoEditor) {
            monacoEditor.getAction('editor.action.formatDocument').run();
        }
    });

    // File Types
    document.querySelectorAll('.file-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const input = document.getElementById('fileNameInput');
            input.value = input.value.split('.')[0] + e.target.dataset.extension;
            input.focus();
        });
    });
}

let slowWorkerTimeout;
let monacoEditor = null;
let cursorsDecorations = [];
let openTabs = [];

window.initMonacoEditor = function () {
    monacoEditor = monaco.editor.create(document.getElementById('monacoEditorContainer'), {
        value: '',
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fixedOverflowWidgets: true
    });

    monacoEditor.onDidChangeModelContent((e) => {
        if (!currentFile || isUpdatingFromFirebase) return;

        const val = monacoEditor.getValue();
        if (files[currentFile]) {
            files[currentFile].content = val;
        }

        updateCursorPositionLocal();

        if (currentFile && currentFile.endsWith('.css')) {
            const iframe = document.getElementById('preview');
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: 'update-css', filename: currentFile, content: val }, '*');
            }
            db.ref(`projects/${currentProject}/files/${encodeFirebasePath(currentFile)}`).update({
                content: val,
                lastModified: firebase.database.ServerValue.TIMESTAMP,
                modifiedBy: currentUser.username
            });
            document.getElementById('syncStatus').querySelector('span').textContent = 'Live Reload CSS...';
        } else {
            db.ref(`projects/${currentProject}/files/${encodeFirebasePath(currentFile)}`).update({
                content: val,
                lastModified: firebase.database.ServerValue.TIMESTAMP,
                modifiedBy: currentUser.username
            });
            document.getElementById('syncStatus').querySelector('span').textContent = 'Guardado';

            clearTimeout(slowWorkerTimeout);
            slowWorkerTimeout = setTimeout(() => {
                if (['index.html', 'script.js'].includes(currentFile)) {
                    updatePreview();
                }
            }, 3000); // Save after 3s to worker/preview
        }
    });

    monacoEditor.onDidChangeCursorPosition((e) => {
        updateCursorPositionLocal();
    });

    if (currentFile && files[currentFile]) {
        openFile(currentFile);
    }
};

function renderTabs() {
    const tabsContainer = document.getElementById('tabs');
    tabsContainer.innerHTML = '';

    openTabs.forEach(fileName => {
        const isActive = currentFile === fileName;
        const hasSuggestions = window.aiSuggestionsStore && window.aiSuggestionsStore[fileName] && window.aiSuggestionsStore[fileName].length > 0;
        const tabEl = document.createElement('button');
        tabEl.className = `tab ${isActive ? 'active' : ''}`;
        tabEl.innerHTML = `
            ${hasSuggestions ? '<span style="color: #ef4444; margin-right: 4px;">✨</span>' : ''}
            <span style="${hasSuggestions ? 'color: #ef4444; font-weight: bold;' : ''}">${fileName}</span>
            <span class="tab-close" onclick="closeTab(event, '${fileName}')">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                    <path d="M3.5 10.5L10.5 3.5"></path>
                    <path d="M3.5 3.5L10.5 10.5"></path>
                </svg>
            </span>
        `;
        tabEl.onclick = () => openFile(fileName);
        tabsContainer.appendChild(tabEl);
    });
}

window.closeTab = function (e, fileName) {
    e.stopPropagation();
    openTabs = openTabs.filter(t => t !== fileName);
    if (currentFile === fileName) {
        if (openTabs.length > 0) {
            openFile(openTabs[openTabs.length - 1]);
        } else {
            currentFile = null;
            if (monacoEditor) monacoEditor.setValue('');
            document.getElementById('currentFileName').textContent = 'Sin archivo seleccionado';
            document.getElementById('currentFileType').textContent = '';
        }
    }
    renderTabs();
    renderFileList();
}

window.setupAiListeners = function () {
    const aiModal = document.getElementById('aiModal');
    const aiInput = document.getElementById('aiInput');
    const aiResponseArea = document.getElementById('aiResponseArea');
    if (!aiModal || !aiInput) return;

    let currentAIAction = '';

    const openAiModal = (actionType) => {
        currentAIAction = actionType;
        document.getElementById('aiModalTitle').textContent = actionType === 'fix' ? '✨ Arreglar Error' : '💡 ¿Cómo añado...?';
        aiInput.value = '';
        aiInput.placeholder = actionType === 'fix' ? 'Describe el error que estás experimentando (ej: "No veo el botón rojo")...' : '¿Qué nueva funcionalidad o estilo te gustaría añadir?...';
        aiResponseArea.style.display = 'none';
        aiResponseArea.innerHTML = '';
        aiModal.classList.add('show');
        aiInput.focus();
    };

    document.getElementById('aiFixBtn').addEventListener('click', () => openAiModal('fix'));
    document.getElementById('aiAddBtn').addEventListener('click', () => openAiModal('add'));
    document.getElementById('closeAiModalBtn').addEventListener('click', () => aiModal.classList.remove('show'));
    document.getElementById('cancelAiBtn').addEventListener('click', () => aiModal.classList.remove('show'));

    document.getElementById('submitAiBtn').addEventListener('click', async () => {
        const query = aiInput.value.trim();
        if (!query) return;

        aiResponseArea.style.display = 'block';
        aiResponseArea.innerHTML = '<i>Analizando con Mistral...</i>';
        document.getElementById('submitAiBtn').disabled = true;

        const position = monacoEditor ? monacoEditor.getPosition() : null;
        const cursorLine = position ? position.lineNumber : 1;

        let allCodeWithLines = '';
        if (files) {
            Object.keys(files).forEach(fname => {
                const lines = files[fname].content.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
                allCodeWithLines += `--- ARCHIVO: ${fname} ---\n${lines}\n\n`;
            });
        }

        const systemPrompt = currentAIAction === 'fix'
            ? "Eres un experto en programación web. El usuario tiene un error. Debes dar la solución indicando EXACTAMENTE el archivo, la línea y el bloque. RESPONDE SOLO USANDO ESTE FORMATO EXACTO obligatorio (puedes mandar varios bloques incluso en distintos archivos):\n\n[INICIO_CAMBIO]\nARCHIVO: index.html\nLINEA: 15\nBUSCAR:\n<el bloque de código original exacto (sin números de línea) que tiene el error>\nEXPLICACION: Añade esto para arreglar el div\nCODIGO:\n<el nuevo bloque de código corregido>\n[FIN_CAMBIO]\n\nImportante: Es vital rellenar ARCHIVO con el nombre exacto, LINEA con número exacto, y BUSCAR con el texto original calcado. SOLO ARREGLA ESTO QUE TE HA DICHO EL USUARIO, NADA MAS"
            : "Eres un experto web. El usuario quiere añadir algo al proyecto. RESPONDE SOLO USANDO ESTE FORMATO EXACTO obligatorio (puedes mandar varios bloques si hay varios cambios en distintos archivos):\n\n[INICIO_CAMBIO]\nARCHIVO: style.css\nLINEA: 15\nBUSCAR:\n<bloque original sin números de línea>\nEXPLICACION: Añade este fondo\nCODIGO:\n<tu sugerencia>\n[FIN_CAMBIO]\n\nImportante: Pon ARCHIVO con exactitud, LINEA con el número y en BUSCAR exactamente el texto fuente. Intenta colocarlo donde tenga más sentido técnico. Quiero que simplemente pongas lo que te ha dicho el usuario que pongas y no pongas ABSOLUTAMENTE NADA MAS, NO ARREGLES NADA QUE TENGA EL USUARIO MAL, SOLO PON LO QUE TE DIGA";

        // Hide modal quickly and run in background so user looks at the editor
        setTimeout(() => aiModal.classList.remove('show'), 1500);

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Aquí están TODOS los archivos del proyecto CON NÚMEROS DE LÍNEA. Úsalos para LINEA y ARCHIVO:\n\n⚠️ NOTA IMPORTANTE: Estoy viendo el archivo "${currentFile}" en la LÍNEA ${cursorLine}. Úsalo como prioridad si mi petición es ambigua.\n\n${allCodeWithLines}\n\nPetición: ${query}` }
        ];

        try {
            const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer evxly62Xv91b752fbnHA2I3HD988C5RT',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({
                    model: 'mistral-large-latest',
                    messages: messages,
                    stream: true
                })
            });

            if (!response.ok) {
                throw new Error("API Error: " + response.status);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let assistantMessage = '';
            let processedChanges = 0;

            aiResponseArea.innerHTML = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (let line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                                assistantMessage += data.choices[0].delta.content;

                                const blockRegex = /\[INICIO_CAMBIO\]\s*ARCHIVO:\s*([^\n]+)\s*LINEA:\s*(\d+)\s*BUSCAR:\s*([\s\S]*?)EXPLICACION:\s*([\s\S]*?)CODIGO:\s*([\s\S]*?)\[FIN_CAMBIO\]/g;
                                let match;
                                let matchCount = 0;
                                while ((match = blockRegex.exec(assistantMessage)) !== null) {
                                    matchCount++;
                                    if (matchCount > processedChanges) {
                                        processedChanges++;
                                        const targetFile = match[1].trim();
                                        const targetLine = parseInt(match[2]);
                                        const originalSearch = match[3].trim();
                                        const expl = match[4].trim();
                                        const codePart = match[5].trim();

                                        let finalLineN = targetLine;
                                        if (monacoEditor && targetFile === currentFile) {
                                            const matches = monacoEditor.getModel().findMatches(originalSearch, false, false, true, null, false);
                                            if (matches && matches.length > 0) {
                                                matches.sort((a, b) => Math.abs(a.range.startLineNumber - targetLine) - Math.abs(b.range.startLineNumber - targetLine));
                                                finalLineN = matches[0].range.startLineNumber;
                                            } else {
                                                const fallbackLineObj = originalSearch.split('\n')[0];
                                                const fallbackMatches = monacoEditor.getModel().findMatches(fallbackLineObj, false, false, true, null, false);
                                                if (fallbackMatches && fallbackMatches.length > 0) {
                                                    fallbackMatches.sort((a, b) => Math.abs(a.range.startLineNumber - targetLine) - Math.abs(b.range.startLineNumber - targetLine));
                                                    finalLineN = fallbackMatches[0].range.startLineNumber;
                                                }
                                            }
                                        }

                                        if (!window.aiSuggestionsStore) window.aiSuggestionsStore = {};
                                        if (!window.aiSuggestionsStore[targetFile]) window.aiSuggestionsStore[targetFile] = [];

                                        const existing = window.aiSuggestionsStore[targetFile].find(x => x.expl === expl && x.codePart === codePart);
                                        if (!existing) {
                                            const newSugg = { id: 'sug_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9), targetLine: finalLineN, originalSearch, expl, codePart };
                                            window.aiSuggestionsStore[targetFile].push(newSugg);
                                            if (targetFile === currentFile && window.addAiSuggestionZone) {
                                                window.addAiSuggestionZone(newSugg.id, newSugg.targetLine, newSugg.expl, newSugg.codePart, newSugg.originalSearch);
                                            }
                                            renderTabs();
                                            renderFileList();
                                        }
                                    }
                                }

                                const displayHtml = assistantMessage
                                    .replace(/\[INICIO_CAMBIO\][\s\S]*?ARCHIVO:\s*([^\n]+)[\s\S]*?\[FIN_CAMBIO\]/g, '<div style="color:var(--accent-primary); font-weight:bold; margin-top: 10px;">✅ ✨ Sugerencia creada para el archivo <b>$1</b>. Ábrelo en sus pestañas y revisa las flechas para aplicarlo.</div>')
                                    .replace(/\n/g, '<br>');
                                aiResponseArea.innerHTML = displayHtml;
                                aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
                            }
                        } catch (e) { }
                    }
                }
            }

        } catch (err) {
            aiResponseArea.innerHTML = '<span style="color:#ef4444;">Error consultando Mistral: ' + err.message + '</span>';
        } finally {
            document.getElementById('submitAiBtn').disabled = false;
        }
    });

};

window.addAiSuggestionZone = function (id, lineNumber, explanation, codePart, originalSearch) {
    if (!monacoEditor) return;

    // Auto format code string removing trailing backticks if AI outputs them
    let cleanCode = codePart.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
    cleanCode = cleanCode.trim();

    monacoEditor.changeViewZones(function (changeAccessor) {
        const domNode = document.createElement('div');
        domNode.style.background = '#1e1e2e';
        domNode.style.border = '1px solid #cba6f7';
        domNode.style.borderLeft = '4px solid #cba6f7';
        domNode.style.padding = '10px';
        domNode.style.zIndex = '10';
        domNode.style.display = 'flex';
        domNode.style.flexDirection = 'column';
        domNode.style.gap = '8px';
        domNode.style.borderRadius = '4px';

        domNode.innerHTML = `
            <div style="color: #cba6f7; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2v20M19 15l-7 7-7-7"/>
                </svg>
                <span><b>IA Sugiere:</b> ${explanation}</span>
            </div>
            <div style="background: #11111b; padding: 10px; border-radius: 4px; font-family: monospace; color: #a6e3a1; overflow-x: auto;">
                <pre style="margin:0; white-space: pre-wrap; font-size:13px;">${cleanCode.replace(/</g, '&lt;')}</pre>
            </div>
            <div style="display: flex; gap: 10px;">
                <button class="btn btn-primary" style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border:none; background: #cba6f7; color: #11111b; cursor:pointer;" onclick="applyAiSuggestion('${id}', this)">Aplicar Cambio</button>
                <button class="btn btn-secondary" style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border:1px solid #cba6f7; background:transparent; color:#cba6f7; cursor:pointer;" onclick="removeAiSuggestion('${id}', this)">Descartar</button>
            </div>
        `;

        const linesOfCode = cleanCode.split('\n').length;
        const estimatedHeight = 90 + (linesOfCode * 18);

        const zoneId = changeAccessor.addZone({
            afterLineNumber: lineNumber > 1 ? lineNumber - 1 : 0, // aparece justo sobre la línea que vamos a sustituir
            heightInPx: estimatedHeight,
            domNode: domNode,
            marginDomNode: null
        });
        domNode.dataset.zoneId = zoneId;
        domNode.dataset.sugId = id;

        window.activeAiZoneIds = window.activeAiZoneIds || [];
        window.activeAiZoneIds.push(zoneId);

        monacoEditor.revealLineInCenter(lineNumber);
    });
};

window.applyAiSuggestion = function (sugId, btn) {
    const zoneId = btn.closest('[data-zone-id]').dataset.zoneId;
    monacoEditor.changeViewZones(function (changeAccessor) {
        changeAccessor.removeZone(zoneId);
        if (window.activeAiZoneIds) window.activeAiZoneIds = window.activeAiZoneIds.filter(id => id !== zoneId);
    });

    let suggestionData = null;
    if (window.aiSuggestionsStore && window.aiSuggestionsStore[currentFile]) {
        suggestionData = window.aiSuggestionsStore[currentFile].find(s => s.id === sugId);
        window.aiSuggestionsStore[currentFile] = window.aiSuggestionsStore[currentFile].filter(s => s.id !== sugId);
        renderTabs();
        renderFileList();
    }

    if (!suggestionData) return;

    let cleanCode = suggestionData.codePart.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    let rangeToReplace;
    if (suggestionData.originalSearch) {
        const matches = monacoEditor.getModel().findMatches(suggestionData.originalSearch, false, false, true, null, false);
        if (matches && matches.length > 0) {
            matches.sort((a, b) => Math.abs(a.range.startLineNumber - suggestionData.targetLine) - Math.abs(b.range.startLineNumber - suggestionData.targetLine));
            rangeToReplace = matches[0].range;
        }
    }

    if (!rangeToReplace) {
        let safeLine = Math.min(suggestionData.targetLine, monacoEditor.getModel().getLineCount());
        if (safeLine < 1) safeLine = 1;
        rangeToReplace = new monaco.Range(safeLine, 1, safeLine, monacoEditor.getModel().getLineMaxColumn(safeLine));
    }

    monacoEditor.executeEdits("ai-suggestion", [{
        range: rangeToReplace,
        text: cleanCode,
        forceMoveMarkers: true
    }]);

    setTimeout(() => {
        if (monacoEditor) monacoEditor.getAction('editor.action.formatDocument').run();
    }, 100);
}

window.removeAiSuggestion = function (sugId, btn) {
    const zoneId = btn.closest('[data-zone-id]').dataset.zoneId;
    monacoEditor.changeViewZones(function (changeAccessor) {
        changeAccessor.removeZone(zoneId);
        if (window.activeAiZoneIds) window.activeAiZoneIds = window.activeAiZoneIds.filter(id => id !== zoneId);
    });

    if (window.aiSuggestionsStore && window.aiSuggestionsStore[currentFile]) {
        window.aiSuggestionsStore[currentFile] = window.aiSuggestionsStore[currentFile].filter(s => s.id !== sugId);
        renderTabs();
        renderFileList();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (window.setupAiListeners) window.setupAiListeners();
    }, 1000);
});

function detachListeners() {
    if (filesRef) filesRef.off();
    if (presenceRef) presenceRef.off();
    if (projectPresenceRef) projectPresenceRef.off();
}

// ===== Project Logic =====
function createProject() {
    const name = document.getElementById('projectNameInput').value.trim();
    const description = document.getElementById('projectDescInput').value.trim();
    if (!name) return showToast('Nombre requerido', 'warning');

    const newProjectRef = db.ref('projects').push();
    const projectId = newProjectRef.key;

    // 1. Prepare default files logic
    const defaultFiles = {
        'index.html': `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div class="container">\n    <h1>${name}</h1>\n    <p>¡Hola Mundo desde CollabCode!</p>\n  </div>\n  <script src="script.js"></script>\n</body>\n</html>`,
        'style.css': `body { font-family: sans-serif; background: #0a0b0d; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }\n.container { text-align: center; }`,
        'script.js': `console.log('Proyecto ${name} iniciado');`
    };

    const filesData = {};
    Object.entries(defaultFiles).forEach(([fname, content]) => {
        const encoded = encodeFirebasePath(fname);
        filesData[encoded] = {
            name: fname,
            content: content,
            type: getFileType(fname),
            lastModified: firebase.database.ServerValue.TIMESTAMP,
            modifiedBy: currentUser.username
        };
    });

    // 2. Construct full project object
    const projectData = {
        name,
        description,
        owner: currentUser.uid,
        ownerUsername: currentUser.username,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        sharedWith: {},
        files: filesData // Include files directly inside projectData
    };

    // 3. Update Firebase (no overlapping paths now)
    const updates = {};
    updates[`projects/${projectId}`] = projectData;
    updates[`users/${currentUser.uid}/projects/${projectId}`] = { name, role: 'owner' };

    db.ref().update(updates)
        .then(() => {
            showToast(`Proyecto ${name} creado`, 'success');
            document.getElementById('newProjectModal').classList.remove('show');
            document.getElementById('projectsModal').classList.remove('show');
            loadProject(projectId);
        })
        .catch(error => {
            console.error(error);
            showToast('Error al crear proyecto', 'error');
        });
}

// ===== Project Loading Logic =====
function loadUserProjects() {
    // Placeholder for initial project loading if needed.
    console.log("Projects ready to load via modal");
}

function loadProject(projectId) {
    detachListeners(); // Cleanup previous project listeners
    currentProject = projectId;
    localStorage.setItem('currentProject', projectId);

    // Get Project Info
    db.ref(`projects/${projectId}`).once('value').then(snapshot => {
        const data = snapshot.val();
        if (data) {
            document.getElementById('currentProject').querySelector('.project-name').textContent = data.name;
            setupRealtimeSync(projectId);
            showToast(`Proyecto "${data.name}" cargado`, 'success');
        } else {
            showToast('Proyecto no encontrado', 'error');
        }
    });
}

// ===== Real-time Sync (WebSockets Optimizado) =====
function setupRealtimeSync(projectId) {
    // Referencia a los archivos del proyecto
    filesRef = db.ref(`projects/${projectId}/files`);

    // 1. ADDED: Cuando se crea o carga un archivo nuevo
    filesRef.on('child_added', (snapshot) => {
        const remoteFile = snapshot.val();
        const encodedName = snapshot.key;
        const decodedName = decodeFirebasePath(encodedName);

        files[decodedName] = remoteFile;
        renderFileList(); // Actualizar lista para mostrar el nuevo archivo

        // Si es el primer archivo y no hay nada abierto, abrirlo
        if (!currentFile && decodedName === 'index.html') {
            openFile('index.html');
        }
    });

    // 2. CHANGED: Cuando cambia el contenido de un archivo
    filesRef.on('child_changed', (snapshot) => {
        const remoteFile = snapshot.val();
        const encodedName = snapshot.key;
        const decodedName = decodeFirebasePath(encodedName);

        // Actualizar estado local
        files[decodedName] = remoteFile;

        // Solo actualizar el editor si:
        // A) Es el archivo que estoy viendo
        // B) Y el cambio NO lo hice yo (chequeando modifiedBy o si estoy escribiendo activamente)
        if (currentFile === decodedName) {
            const editor = document.getElementById('codeEditor');

            // Si el usuario remoto NO soy yo, actualizamos
            if (remoteFile.modifiedBy !== currentUser.username || (monacoEditor && remoteFile.content !== monacoEditor.getValue())) {
                if (remoteFile.modifiedBy !== currentUser.username) {
                    isUpdatingFromFirebase = true;
                    if (monacoEditor) {
                        const pos = monacoEditor.getPosition();
                        monacoEditor.setValue(remoteFile.content || '');
                        monacoEditor.setPosition(pos);
                    }
                    isUpdatingFromFirebase = false;
                }
            }
        }
    });

    // 3. REMOVED: Cuando se elimina un archivo
    filesRef.on('child_removed', (snapshot) => {
        const encodedName = snapshot.key;
        const decodedName = decodeFirebasePath(encodedName);

        delete files[decodedName];

        if (currentFile === decodedName) {
            currentFile = null;
            document.getElementById('codeEditor').value = '';
            document.getElementById('currentFileName').textContent = 'Eliminado';
        }
        renderFileList();
    });

    // 4. Presence System
    setupPresence(projectId);
}

function setupPresence(projectId) {
    // My presence reference
    const myPresenceRef = db.ref(`projects/${projectId}/presence/${currentUser.uid}`);

    // Set my presence
    const updateMyPresence = () => {
        if (!currentProject) return;
        myPresenceRef.set({
            username: currentUser.username,
            viewingFile: currentFile || null,
            lastSeen: firebase.database.ServerValue.TIMESTAMP,
            state: 'online'
        });
    };

    // Update on disconnect
    myPresenceRef.onDisconnect().remove();

    // Update when changing files
    // (This calls updateMyPresence inside openFile)

    // Heartbeat to keep "lastSeen" fresh
    if (window.presenceInterval) clearInterval(window.presenceInterval);
    window.presenceInterval = setInterval(updateMyPresence, 10000); // reduced frequency since onDisconnect handles the offline part

    // Listen to others
    projectPresenceRef = db.ref(`projects/${projectId}/presence`);
    projectPresenceRef.on('value', (snapshot) => {
        projectUsers = snapshot.val() || {};
        const count = Object.keys(projectUsers).length;
        document.getElementById('userCount').textContent = count;
        renderFileList(); // Update avatars
        renderCursors(); // Render floating cursors
    });
}

// ===== File Operations =====
function openFile(fileName) {
    if (!files[fileName]) return;
    currentFile = fileName;

    if (!openTabs.includes(fileName)) {
        openTabs.push(fileName);
    }

    const file = files[fileName];

    if (monacoEditor) {
        if (window.activeAiZoneIds) {
            monacoEditor.changeViewZones(function (accessor) {
                window.activeAiZoneIds.forEach(z => accessor.removeZone(z));
            });
            window.activeAiZoneIds = [];
        }

        isUpdatingFromFirebase = true;
        monacoEditor.setValue(file.content || '');
        let lang = 'javascript';
        if (fileName.endsWith('.html')) lang = 'html';
        else if (fileName.endsWith('.css')) lang = 'css';
        else if (fileName.endsWith('.json')) lang = 'json';
        monaco.editor.setModelLanguage(monacoEditor.getModel(), lang);
        isUpdatingFromFirebase = false;
    }

    document.getElementById('currentFileName').textContent = fileName;
    document.getElementById('currentFileType').textContent = file.type.toUpperCase();

    renderTabs();
    renderFileList();
    updatePreview();

    // Update presence immediately
    if (currentProject) {
        db.ref(`projects/${currentProject}/presence/${currentUser.uid}`).update({
            viewingFile: fileName
        });
    }

    setTimeout(() => {
        if (window.aiSuggestionsStore && window.aiSuggestionsStore[fileName]) {
            window.aiSuggestionsStore[fileName].forEach(sug => {
                if (window.addAiSuggestionZone) window.addAiSuggestionZone(sug.id, sug.targetLine, sug.expl, sug.codePart, sug.originalSearch);
            });
        }
    }, 150);
}

function saveFileToFirebase(fileName, content) {
    if (!currentProject) return;
    const encoded = encodeFirebasePath(fileName);

    db.ref(`projects/${currentProject}/files/${encoded}`).update({
        content: content,
        lastModified: firebase.database.ServerValue.TIMESTAMP,
        modifiedBy: currentUser.username
    });

    document.getElementById('syncStatus').querySelector('span').textContent = 'Guardado';
}

function createFile() {
    const name = document.getElementById('fileNameInput').value.trim();
    if (!name || !currentProject) return;

    const encoded = encodeFirebasePath(name);
    db.ref(`projects/${currentProject}/files/${encoded}`).set({
        name: name,
        content: '',
        type: getFileType(name),
        lastModified: firebase.database.ServerValue.TIMESTAMP,
        modifiedBy: currentUser.username
    }).then(() => {
        openFile(name);
        document.getElementById('newFileModal').classList.remove('show');
    });
}

function deleteCurrentFile() {
    if (!currentFile || !currentProject) return;
    if (!confirm('¿Eliminar archivo?')) return;

    const encoded = encodeFirebasePath(currentFile);
    db.ref(`projects/${currentProject}/files/${encoded}`).remove().then(() => {
        currentFile = null;
        document.getElementById('codeEditor').value = '';
    });
}

// ===== UI & Helpers =====
function updatePreview() {
    if (!currentProject) return;

    const iframe = document.getElementById('preview');
    // Usamos timestamp para evitar caché
    const workerUrl = `https://collab.logise1123.workers.dev/view/${currentProject}/index.html?t=${Date.now()}`;

    // Forzamos la carga de la URL
    iframe.src = workerUrl;
    iframe.dataset.projectId = currentProject;
}

function renderFileList() {
    const list = document.getElementById('fileList');
    list.innerHTML = '';

    Object.keys(files).sort().forEach(fileName => {
        const file = files[fileName];
        const isActive = currentFile === fileName;

        // Find viewers
        const viewers = Object.values(projectUsers).filter(u => u.viewingFile === fileName && u.username !== currentUser.username);

        const item = document.createElement('div');
        item.className = `file-item ${isActive ? 'active' : ''}`;

        const hasSuggestions = window.aiSuggestionsStore && window.aiSuggestionsStore[fileName] && window.aiSuggestionsStore[fileName].length > 0;

        let avatars = '';
        if (viewers.length > 0) {
            avatars = `<div style="display:flex; gap:2px; margin-left:auto;">
                ${viewers.map(u => {
                const uname = u.username || '?';
                return `<div title="${uname}" style="width:16px;height:16px;border-radius:50%;background:${stringToColor(uname)};color:white;font-size:8px;display:flex;align-items:center;justify-content:center;">${uname[0].toUpperCase()}</div>`;
            }).join('')}
            </div>`;
        }

        item.innerHTML = `${getFileIcon(file.type)} <span class="file-name" style="${hasSuggestions ? 'color: #ef4444; font-weight: bold;' : ''}">${fileName} ${hasSuggestions ? '✨' : ''}</span> ${avatars}`;
        item.onclick = () => openFile(fileName);
        list.appendChild(item);
    });
}

function renderProjectsList() {
    const list = document.getElementById('projectsList');
    list.innerHTML = 'Cargando...';

    // Fetch my projects
    db.ref(`users/${currentUser.uid}/projects`).once('value', snapshot => {
        const myProjects = snapshot.val() || {};
        // Fetch shared projects (if we had index) - simplified for now to just show owner's
        // In this architecture, we listed projects under /users/{uid}/projects.

        list.innerHTML = '';

        if (Object.keys(myProjects).length === 0) {
            list.innerHTML = 'No tienes proyectos.';
            return;
        }

        Object.keys(myProjects).forEach(projectId => {
            const p = myProjects[projectId];
            const div = document.createElement('div');
            div.className = 'project-card';
            div.innerHTML = `<h4>${p.name}</h4><p>${p.role === 'owner' ? 'Propietario' : 'Compartido'}</p>`;
            div.onclick = () => {
                loadProject(projectId);
                document.getElementById('projectsModal').classList.remove('show');
            };
            list.appendChild(div);
        });
    });
}

// Sharing Logic
function shareProject() {
    const emailToShare = document.getElementById('shareUsernameInput').value.trim(); // User will input email now likely, or username if we index it.
    // Given the difficulty of finding UID by username without a cloud function or allowing full list reading, 
    // we will implement a simple "exact match" search on a public /usernames node if we had it, OR
    // for this demo, we can ask for the EXACT EMAIL.

    // Let's assume for this specific request we want to stick to what works:
    // We already query by username structure. But Auth is Email based.
    // The previous prompt said "username (para mostrar)".
    // Finding a user by username in Firebase without Cloud Functions requires a query.
    // db.ref('users').orderByChild('username').equalTo(targetUsername)...

    if (!emailToShare || !currentProject) return;

    // Note: This requires .indexOn: ["email"] rules in Firebase, which we can't set from here.
    // Instead, we'll try to scan `users` (inefficient but works for small demo apps).

    db.ref('users').orderByChild('email').equalTo(emailToShare).once('value', snapshot => {
        if (!snapshot.exists()) {
            return showToast('Usuario no encontrado (usa el email exacto)', 'error');
        }

        const targetUid = Object.keys(snapshot.val())[0];
        const targetUser = snapshot.val()[targetUid];

        // Grant access
        const updates = {};
        updates[`projects/${currentProject}/sharedWith/${targetUid}`] = { username: targetUser.username, email: targetUser.email };
        updates[`users/${targetUid}/projects/${currentProject}`] = { name: document.getElementById('currentProject').innerText, role: 'editor' };

        db.ref().update(updates).then(() => {
            showToast(`Compartido con ${targetUser.username}`, 'success');
        });
    });
}

function encodeFirebasePath(path) { return path.replace(/\./g, '_DOT_').replace(/\//g, '_SLASH_'); }
function decodeFirebasePath(path) { return path.replace(/_DOT_/g, '.').replace(/_SLASH_/g, '/'); }
function getFileType(n) { return n.split('.').pop(); }
function getFileIcon(t) { return '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2"/></svg>'; } // simplified
function stringToColor(str) {
    if (!str) return '#667eea';
    // basic hash to color
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '000000'.substring(0, 6 - c.length) + c;
}
function showToast(m, t) { console.log(m); } // simplistic fallback 
function formatCode() { } // stub
function isLocalDirty() { return false; } // stub helper

function getCaretCoordinates(element, position) {
    return { top: 0, left: 0, height: 18 };
}

function updateCursorPositionLocal() {
    if (!currentProject || !currentFile || !currentUser || !monacoEditor) return;

    const pos = monacoEditor.getPosition();
    if (pos) {
        db.ref(`projects/${currentProject}/presence/${currentUser.uid}`).update({
            cursorPos: pos
        });
        document.getElementById('lineNumber').textContent = pos.lineNumber;
        document.getElementById('columnNumber').textContent = pos.column;
    }
}

function renderCursors() {
    if (!currentProject || !currentFile || !monacoEditor || typeof monaco === 'undefined') return;

    let newDecorations = [];
    Object.keys(projectUsers).forEach(uid => {
        if (uid === currentUser.uid) return;
        const user = projectUsers[uid];
        if (user.viewingFile !== currentFile || !user.cursorPos || user.state !== 'online') return;

        const color = stringToColor(user.username);
        let styleId = 'cursor-style-' + uid;
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }

        styleEl.innerHTML = `
            .cursor-uid-${uid} {
                position: absolute;
                border-left: 2px solid ${color};
                z-index: 100;
            }
            .cursor-uid-${uid}::after {
                content: '${user.username || '?'}';
                position: absolute;
                top: -16px;
                left: 0;
                background: ${color};
                color: white;
                font-size: 10px;
                padding: 1px 4px;
                border-radius: 2px;
                white-space: nowrap;
                pointer-events: none;
                z-index: 101;
            }
        `;

        newDecorations.push({
            range: new monaco.Range(user.cursorPos.lineNumber, user.cursorPos.column, user.cursorPos.lineNumber, user.cursorPos.column),
            options: { className: `cursor-uid-${uid}` }
        });
    });

    cursorsDecorations = monacoEditor.deltaDecorations(cursorsDecorations, newDecorations);
}
