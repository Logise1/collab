// ===== Initialize Firebase =====
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.database();

// ===== State =====
let currentUser = null;
let currentProject = null;
let currentFile = null;
let files = {}; // { fileName: { name, content, type, ... } }
let projectUsers = {};
let isUpdatingFromFirebase = false;
let monacoEditor = null;
let cursorsDecorations = [];
let openTabs = [];
let filesRef = null;
let presenceRef = null;
let projectPresenceRef = null;
let autoBackupInterval = null;
let slowWorkerTimeout = null;

// ===== Toast Notifications =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `
        <span style="font-size:1.1rem;">${icons[type] || 'ℹ️'}</span>
        <span class="toast-message">${message}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(400px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ===== Utility Functions =====
function encodeFirebasePath(path) {
    return path.replace(/\./g, '_DOT_').replace(/\//g, '_SLASH_');
}
function decodeFirebasePath(path) {
    return path.replace(/_DOT_/g, '.').replace(/_SLASH_/g, '/');
}
function getFileType(name) {
    return name.split('.').pop().toLowerCase();
}
function getFileIcon(type) {
    const icons = {
        html: '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="#e34c26" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>',
        css: '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="#264de4" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>',
        js: '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="#f7df1e" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>',
        json: '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="#5a9" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>',
    };
    return icons[type] || '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
}
function stringToColor(str) {
    if (!str) return '#667eea';
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '000000'.substring(0, 6 - c.length) + c;
}

// ===== Detach Firebase Listeners =====
function detachListeners() {
    if (filesRef) { filesRef.off(); filesRef = null; }
    if (presenceRef) { presenceRef.off(); presenceRef = null; }
    if (projectPresenceRef) { projectPresenceRef.off(); projectPresenceRef = null; }
    if (autoBackupInterval) { clearInterval(autoBackupInterval); autoBackupInterval = null; }
    if (window.presenceInterval) { clearInterval(window.presenceInterval); window.presenceInterval = null; }
}

// ===== Auth Check =====
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const snapshot = await db.ref(`users/${user.uid}`).once('value');
        const userData = snapshot.val();
        currentUser = {
            uid: user.uid,
            email: user.email,
            username: userData ? userData.username : user.email.split('@')[0]
        };
    } catch (e) {
        currentUser = { uid: user.uid, email: user.email, username: user.email.split('@')[0] };
    }

    document.getElementById('currentUsername').textContent = currentUser.username;
    document.getElementById('mainApp').style.display = 'flex';

    // Check which project to open (passed via sessionStorage)
    const projectId = sessionStorage.getItem('openProjectId');
    if (projectId) {
        sessionStorage.removeItem('openProjectId');
        loadProject(projectId);
    } else {
        // No project selected, redirect to projects page
        window.location.href = 'projects.html';
    }

    setupEditorListeners();
});

// ===== Monaco Editor Init =====
window.initMonacoEditor = function () {
    monacoEditor = monaco.editor.create(document.getElementById('monacoEditorContainer'), {
        value: '',
        language: 'html',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fixedOverflowWidgets: true,
        fontSize: 14,
        lineHeight: 22,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
    });

    monacoEditor.onDidChangeModelContent(() => {
        if (!currentFile || isUpdatingFromFirebase) return;

        const val = monacoEditor.getValue();
        if (files[currentFile]) {
            files[currentFile].content = val;
        }

        updateCursorPositionLocal();

        // FIX: Corrected Firebase paths (no spaces)
        const encoded = encodeFirebasePath(currentFile);
        db.ref(`projects/${currentProject}/files/${encoded}`).update({
            content: val,
            lastModified: firebase.database.ServerValue.TIMESTAMP,
            modifiedBy: currentUser.username
        });

        const syncSpan = document.querySelector('#syncStatus span');
        if (syncSpan) syncSpan.textContent = 'Guardando...';

        // Update preview with debounce
        clearTimeout(slowWorkerTimeout);
        slowWorkerTimeout = setTimeout(() => {
            updatePreview();
            if (syncSpan) syncSpan.textContent = 'Sincronizado';
        }, 2000);
    });

    monacoEditor.onDidChangeCursorPosition(() => {
        updateCursorPositionLocal();
    });

    if (currentFile && files[currentFile]) {
        loadFileIntoEditor(currentFile);
    }

    // Setup AI listeners now that monaco is ready
    setupAiListeners();
};

// ===== Load Project =====
function loadProject(projectId) {
    // FIX: Clear all previous state before loading a new project
    detachListeners();
    files = {};
    openTabs = [];
    currentFile = null;
    projectUsers = {};

    if (monacoEditor) {
        isUpdatingFromFirebase = true;
        monacoEditor.setValue('');
        isUpdatingFromFirebase = false;
    }

    renderFileList();
    renderTabs();

    currentProject = projectId;
    document.getElementById('currentFileName').textContent = 'Sin archivo seleccionado';
    document.getElementById('currentFileType').textContent = '';

    db.ref(`projects/${projectId}`).once('value').then(snapshot => {
        const data = snapshot.val();
        if (!data) {
            showToast('Proyecto no encontrado', 'error');
            return;
        }
        document.querySelector('#currentProjectDisplay .project-name').textContent = data.name;
        document.title = `CollabCode - ${data.name}`;
        setupRealtimeSync(projectId);
        showToast(`Proyecto "${data.name}" cargado`, 'success');
    }).catch(err => {
        console.error(err);
        showToast('Error al cargar el proyecto', 'error');
    });
}

// ===== Real-time Sync =====
function setupRealtimeSync(projectId) {
    filesRef = db.ref(`projects/${projectId}/files`);

    // ADDED: New or existing file loaded
    filesRef.on('child_added', (snapshot) => {
        const remoteFile = snapshot.val();
        const decodedName = decodeFirebasePath(snapshot.key);
        files[decodedName] = remoteFile;
        renderFileList();

        // FIX: Only auto-open index.html if no file is currently open
        if (!currentFile && decodedName === 'index.html') {
            openFile('index.html');
        } else if (!currentFile && Object.keys(files).length === 1) {
            openFile(decodedName);
        }
    });

    // CHANGED: Remote update
    filesRef.on('child_changed', (snapshot) => {
        const remoteFile = snapshot.val();
        const decodedName = decodeFirebasePath(snapshot.key);

        files[decodedName] = remoteFile;

        // Only update editor if this is the currently open file AND the change is from another user
        if (currentFile === decodedName && remoteFile.modifiedBy !== currentUser.username) {
            if (monacoEditor) {
                const model = monacoEditor.getModel();
                if (model && remoteFile.content !== undefined && remoteFile.content !== model.getValue()) {
                    isUpdatingFromFirebase = true;
                    const pos = monacoEditor.getPosition();
                    monacoEditor.executeEdits('firebase', [{
                        range: model.getFullModelRange(),
                        text: remoteFile.content || ''
                    }]);
                    if (pos) monacoEditor.setPosition(pos);
                    isUpdatingFromFirebase = false;
                }
            }
        }
    });

    // REMOVED: File deleted
    filesRef.on('child_removed', (snapshot) => {
        const decodedName = decodeFirebasePath(snapshot.key);
        delete files[decodedName];

        if (currentFile === decodedName) {
            currentFile = null;
            openTabs = openTabs.filter(t => t !== decodedName);
            if (monacoEditor) {
                isUpdatingFromFirebase = true;
                monacoEditor.setValue('');
                isUpdatingFromFirebase = false;
            }
            document.getElementById('currentFileName').textContent = 'Archivo eliminado';
            document.getElementById('currentFileType').textContent = '';

            // Open another tab if any
            if (openTabs.length > 0) {
                openFile(openTabs[openTabs.length - 1]);
            }
        }
        openTabs = openTabs.filter(t => t !== decodedName);
        renderFileList();
        renderTabs();
    });

    setupPresence(projectId);

    autoBackupInterval = setInterval(() => {
        checkAndCreateAutoBackup();
    }, 10 * 60 * 1000);
}

// ===== Presence =====
function setupPresence(projectId) {
    const myPresenceRef = db.ref(`projects/${projectId}/presence/${currentUser.uid}`);

    const updateMyPresence = () => {
        if (!currentProject) return;
        myPresenceRef.set({
            username: currentUser.username,
            viewingFile: currentFile || null,
            lastSeen: firebase.database.ServerValue.TIMESTAMP,
            state: 'online'
        });
    };

    myPresenceRef.onDisconnect().remove();
    updateMyPresence();

    if (window.presenceInterval) clearInterval(window.presenceInterval);
    window.presenceInterval = setInterval(updateMyPresence, 10000);

    projectPresenceRef = db.ref(`projects/${projectId}/presence`);
    projectPresenceRef.on('value', (snapshot) => {
        projectUsers = snapshot.val() || {};
        const count = Object.keys(projectUsers).length;
        document.getElementById('userCount').textContent = count;
        renderFileList();
        renderCursors();
    });
}

// ===== File Operations =====
function openFile(fileName) {
    if (!files[fileName]) return;
    currentFile = fileName;

    if (!openTabs.includes(fileName)) {
        openTabs.push(fileName);
    }

    if (monacoEditor) {
        // Remove AI zones
        if (window.activeAiZoneIds && window.activeAiZoneIds.length > 0) {
            monacoEditor.changeViewZones(function (accessor) {
                window.activeAiZoneIds.forEach(z => accessor.removeZone(z));
            });
            window.activeAiZoneIds = [];
        }

        loadFileIntoEditor(fileName);
    }

    document.getElementById('currentFileName').textContent = fileName;
    const fileType = files[fileName].type || getFileType(fileName);
    document.getElementById('currentFileType').textContent = fileType.toUpperCase();

    renderTabs();
    renderFileList();
    updatePreview();

    // Update presence
    if (currentProject) {
        db.ref(`projects/${currentProject}/presence/${currentUser.uid}`).update({
            viewingFile: fileName
        });
    }

    // Restore AI suggestions for this file
    setTimeout(() => {
        if (window.aiSuggestionsStore && window.aiSuggestionsStore[fileName]) {
            window.aiSuggestionsStore[fileName].forEach(sug => {
                if (window.addAiSuggestionZone) {
                    window.addAiSuggestionZone(sug.id, sug.targetLine, sug.expl, sug.codePart, sug.originalSearch);
                }
            });
        }
    }, 150);
}

function loadFileIntoEditor(fileName) {
    if (!monacoEditor || !files[fileName]) return;
    isUpdatingFromFirebase = true;
    const content = files[fileName].content || '';
    monacoEditor.setValue(content);

    let lang = 'plaintext';
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'html') lang = 'html';
    else if (ext === 'css') lang = 'css';
    else if (ext === 'js') lang = 'javascript';
    else if (ext === 'json') lang = 'json';
    else if (ext === 'ts') lang = 'typescript';
    else if (ext === 'md') lang = 'markdown';

    monaco.editor.setModelLanguage(monacoEditor.getModel(), lang);
    isUpdatingFromFirebase = false;
}

function createFile() {
    const name = document.getElementById('fileNameInput').value.trim();
    if (!name) return showToast('Escribe un nombre para el archivo', 'warning');
    if (!currentProject) return showToast('No hay proyecto activo', 'error');
    if (files[name]) return showToast('Ya existe un archivo con ese nombre', 'warning');

    const encoded = encodeFirebasePath(name);
    db.ref(`projects/${currentProject}/files/${encoded}`).set({
        name: name,
        content: '',
        type: getFileType(name),
        lastModified: firebase.database.ServerValue.TIMESTAMP,
        modifiedBy: currentUser.username
    }).then(() => {
        document.getElementById('fileNameInput').value = '';
        document.getElementById('newFileModal').classList.remove('show');
        // child_added listener will handle opening
    }).catch(err => {
        showToast('Error al crear el archivo', 'error');
        console.error(err);
    });
}

// FIX: deleteCurrentFile now uses monacoEditor, not a deleted textarea
function deleteCurrentFile() {
    if (!currentFile || !currentProject) return;
    if (!confirm(`¿Eliminar "${currentFile}"? Esta acción no se puede deshacer.`)) return;

    const encoded = encodeFirebasePath(currentFile);
    db.ref(`projects/${currentProject}/files/${encoded}`).remove()
        .catch(err => {
            showToast('Error al eliminar el archivo', 'error');
            console.error(err);
        });
    // child_removed listener handles cleanup
}

// ===== Preview =====
function updatePreview() {
    if (!currentProject) return;
    const iframe = document.getElementById('preview');
    const workerUrl = `https://collab.logise1123.workers.dev/view/${currentProject}/index.html?t=${Date.now()}`;
    iframe.src = workerUrl;
}

// ===== Render Functions =====
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
            <span class="tab-close" data-filename="${fileName}">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor">
                    <path d="M3.5 10.5L10.5 3.5"></path>
                    <path d="M3.5 3.5L10.5 10.5"></path>
                </svg>
            </span>
        `;
        tabEl.addEventListener('click', (e) => {
            if (!e.target.closest('.tab-close')) {
                openFile(fileName);
            }
        });
        tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(fileName);
        });
        tabsContainer.appendChild(tabEl);
    });
}

function closeTab(fileName) {
    openTabs = openTabs.filter(t => t !== fileName);
    if (currentFile === fileName) {
        if (openTabs.length > 0) {
            openFile(openTabs[openTabs.length - 1]);
        } else {
            currentFile = null;
            if (monacoEditor) {
                isUpdatingFromFirebase = true;
                monacoEditor.setValue('');
                isUpdatingFromFirebase = false;
            }
            document.getElementById('currentFileName').textContent = 'Sin archivo seleccionado';
            document.getElementById('currentFileType').textContent = '';
        }
    }
    renderTabs();
    renderFileList();
}

function renderFileList() {
    const list = document.getElementById('fileList');
    list.innerHTML = '';

    Object.keys(files).sort().forEach(fileName => {
        const file = files[fileName];
        const isActive = currentFile === fileName;
        const viewers = Object.values(projectUsers).filter(u => u.viewingFile === fileName && u.username !== currentUser.username);
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

        const item = document.createElement('div');
        item.className = `file-item ${isActive ? 'active' : ''}`;
        item.innerHTML = `${getFileIcon(file.type || getFileType(fileName))} <span class="file-name" style="${hasSuggestions ? 'color: #ef4444; font-weight: bold;' : ''}">${fileName}${hasSuggestions ? ' ✨' : ''}</span> ${avatars}`;
        item.addEventListener('click', () => openFile(fileName));
        list.appendChild(item);
    });
}

// ===== Cursor Position =====
function updateCursorPositionLocal() {
    if (!monacoEditor) return;
    const pos = monacoEditor.getPosition();
    if (pos) {
        document.getElementById('lineNumber').textContent = pos.lineNumber;
        document.getElementById('columnNumber').textContent = pos.column;

        // FIX: Removed spaces in Firebase path
        if (currentProject && currentUser) {
            db.ref(`projects/${currentProject}/presence/${currentUser.uid}`).update({
                cursorPos: { lineNumber: pos.lineNumber, column: pos.column }
            });
        }
    }
}

// ===== Cursors Rendering =====
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

        // FIX: Fixed CSS class names (removed spaces in property names)
        styleEl.innerHTML = `
            .cursor-uid-${uid} {
                position: absolute;
                border-left: 2px solid ${color};
                z-index: 100;
            }
            .cursor-uid-${uid}::after {
                content: '${(user.username || '?').replace(/'/g, "\\'")}';
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

// ===== Backups =====
function createBackup(isManual = false) {
    if (!currentProject || Object.keys(files).length === 0) return;

    let totalSize = 0;
    let filesInfo = [];
    let filesData = {};

    Object.keys(files).forEach(fileName => {
        const content = files[fileName].content || '';
        totalSize += content.length;
        filesInfo.push({ name: fileName, size: content.length, lines: content.split('\n').length });
        filesData[encodeFirebasePath(fileName)] = files[fileName];
    });

    db.ref(`projects/${currentProject}/backups`).push({
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        isManual,
        createdBy: currentUser.username,
        totalSize,
        filesInfo,
        filesData
    }).then(() => {
        if (isManual) showToast('Backup creado con éxito', 'success');
        enforceBackupsLimit();
        if (document.getElementById('backupsModal').classList.contains('show')) {
            renderBackupsList();
        }
    }).catch(err => {
        console.error('Error creating backup:', err);
        if (isManual) showToast('Error al crear backup', 'error');
    });
}

function enforceBackupsLimit() {
    if (!currentProject) return;
    const backupsRef = db.ref(`projects/${currentProject}/backups`);
    backupsRef.orderByChild('timestamp').once('value', snapshot => {
        if (!snapshot.exists()) return;
        const backups = [];
        snapshot.forEach(child => backups.push({ id: child.key }));
        if (backups.length > 20) {
            backups.slice(0, backups.length - 20).forEach(b => backupsRef.child(b.id).remove());
        }
    });
}

function checkAndCreateAutoBackup() {
    if (!currentProject || !currentUser || Object.keys(files).length === 0) return;
    const onlineUsers = Object.values(projectUsers).filter(u => u.state === 'online' && u.username);
    if (onlineUsers.length === 0) return;
    onlineUsers.sort((a, b) => a.username.localeCompare(b.username));
    if (onlineUsers[0].username === currentUser.username) {
        createBackup(false);
    }
}

function renderBackupsList() {
    const list = document.getElementById('backupsList');
    list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;">Cargando backups...</p>';
    if (!currentProject) return;

    db.ref(`projects/${currentProject}/backups`).orderByChild('timestamp').once('value', snapshot => {
        list.innerHTML = '';
        if (!snapshot.exists()) {
            list.innerHTML = '<p style="color: var(--text-secondary); text-align: center; margin-top: 1rem;">No hay backups disponibles.</p>';
            document.getElementById('backupsCount').textContent = '0/20 backups';
            return;
        }

        const backups = [];
        snapshot.forEach(child => backups.unshift({ id: child.key, ...child.val() }));
        document.getElementById('backupsCount').textContent = `${backups.length}/20 backups`;

        backups.forEach(backup => {
            const date = backup.timestamp ? new Date(backup.timestamp).toLocaleString('es-ES') : 'Fecha desconocida';
            const sizeKB = ((backup.totalSize || 0) / 1024).toFixed(2);
            const filesHtml = (backup.filesInfo || []).map(f =>
                `<div style="font-size: 0.8rem; color: var(--text-tertiary); margin-left: 10px;">📄 ${f.name} - ${f.lines} líneas (${f.size} B)</div>`
            ).join('');

            const item = document.createElement('div');
            item.className = 'project-card';
            item.style.cssText = 'display:flex;flex-direction:column;gap:8px;cursor:default;';
            item.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <h4 style="margin: 0; font-size: 0.95rem;">Backup - ${date}</h4>
                    <span style="font-size: 0.8rem; color: var(--text-tertiary); padding: 2px 6px; background: var(--bg-tertiary); border-radius: 4px;">${backup.isManual ? 'Manual' : 'Auto'} · ${backup.createdBy}</span>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-secondary);">Tamaño: ${sizeKB} KB</div>
                <div style="background: var(--bg-primary); padding: 8px; border-radius: 4px; display: flex; flex-direction: column; gap: 4px;">${filesHtml}</div>
                <div style="display: flex; justify-content: flex-end;">
                    <button class="btn btn-primary" data-backup-id="${backup.id}" style="padding: 4px 12px; font-size: 0.8rem;">↩ Hacer Rollback</button>
                </div>
            `;
            item.querySelector('button').addEventListener('click', () => rollbackToBackup(backup.id));
            list.appendChild(item);
        });
    });
}

function rollbackToBackup(backupId) {
    if (!currentProject) return;
    if (!confirm('¿Hacer rollback? El estado actual se guardará como backup antes.')) return;

    createBackup(true);
    db.ref(`projects/${currentProject}/backups/${backupId}`).once('value', snapshot => {
        if (!snapshot.exists()) return;
        const backupData = snapshot.val();
        if (backupData.filesData) {
            db.ref(`projects/${currentProject}/files`).set(backupData.filesData).then(() => {
                showToast('Rollback completado', 'success');
                document.getElementById('backupsModal').classList.remove('show');
            }).catch(err => {
                console.error(err);
                showToast('Error al hacer rollback', 'error');
            });
        }
    });
}

// ===== Share Project =====
function shareProject() {
    const email = document.getElementById('shareEmailInput').value.trim();
    if (!email || !currentProject) return;

    db.ref('users').orderByChild('email').equalTo(email).once('value', snapshot => {
        if (!snapshot.exists()) {
            return showToast('Usuario no encontrado con ese email', 'error');
        }
        const targetUid = Object.keys(snapshot.val())[0];
        const targetUser = snapshot.val()[targetUid];

        const projectName = document.querySelector('#currentProjectDisplay .project-name').textContent;

        // FIX: Removed spaces in Firebase paths
        const updates = {};
        updates[`projects/${currentProject}/sharedWith/${targetUid}`] = { username: targetUser.username, email: targetUser.email };
        updates[`users/${targetUid}/projects/${currentProject}`] = { name: projectName, role: 'editor' };

        db.ref().update(updates).then(() => {
            showToast(`Proyecto compartido con ${targetUser.username}`, 'success');
            document.getElementById('shareEmailInput').value = '';
            document.getElementById('shareModal').classList.remove('show');
        }).catch(err => {
            console.error(err);
            showToast('Error al compartir', 'error');
        });
    });
}

// ===== Editor Event Listeners =====
function setupEditorListeners() {
    // Connection Status
    db.ref('.info/connected').on('value', (snap) => {
        const statusDot = document.querySelector('#connectionStatus .status-dot');
        const statusText = document.querySelector('#connectionStatus span');
        if (snap.val() === true) {
            if (statusDot) statusDot.classList.add('connected');
            if (statusText) statusText.textContent = 'Conectado';
        } else {
            if (statusDot) statusDot.classList.remove('connected');
            if (statusText) statusText.textContent = 'Conectando...';
        }
    });

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', () => {
        detachListeners();
        auth.signOut().then(() => {
            window.location.href = 'index.html';
        });
    });

    // Buttons
    document.getElementById('refreshPreviewBtn').addEventListener('click', () => {
        updatePreview();
        showToast('Vista previa actualizada', 'info');
    });

    document.getElementById('openInNewTabBtn').addEventListener('click', () => {
        if (currentProject) {
            window.open(`https://collab.logise1123.workers.dev/view/${currentProject}/index.html`, '_blank');
        } else {
            showToast('Abre un proyecto primero', 'warning');
        }
    });

    // FIX: formatBtn only bound once
    document.getElementById('formatBtn').addEventListener('click', () => {
        if (monacoEditor) {
            monacoEditor.getAction('editor.action.formatDocument').run();
        }
    });

    document.getElementById('deleteFileBtn').addEventListener('click', deleteCurrentFile);
    document.getElementById('newFileBtn').addEventListener('click', () => {
        document.getElementById('newFileModal').classList.add('show');
        setTimeout(() => document.getElementById('fileNameInput').focus(), 100);
    });
    document.getElementById('createFileBtn').addEventListener('click', createFile);
    document.getElementById('fileNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createFile();
    });

    // File type buttons
    document.querySelectorAll('.file-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const input = document.getElementById('fileNameInput');
            const base = input.value.includes('.') ? input.value.split('.')[0] : input.value;
            input.value = base + e.target.dataset.extension;
            input.focus();
        });
    });

    // Modal closers
    const closeModal = (modalId) => document.getElementById(modalId).classList.remove('show');

    document.getElementById('closeModalBtn').addEventListener('click', () => closeModal('newFileModal'));
    document.getElementById('cancelNewFileBtn').addEventListener('click', () => closeModal('newFileModal'));
    document.getElementById('closeBackupsModalBtn').addEventListener('click', () => closeModal('backupsModal'));
    document.getElementById('closeShareModalBtn').addEventListener('click', () => closeModal('shareModal'));
    document.getElementById('cancelShareBtn').addEventListener('click', () => closeModal('shareModal'));

    document.getElementById('backupsBtn').addEventListener('click', () => {
        document.getElementById('backupsModal').classList.add('show');
        renderBackupsList();
    });
    document.getElementById('shareBtn').addEventListener('click', () => {
        document.getElementById('shareModal').classList.add('show');
    });
    document.getElementById('manualBackupBtn').addEventListener('click', () => createBackup(true));
    document.getElementById('addShareBtn').addEventListener('click', shareProject);

    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('show');
        });
    });
}

// ===== AI Assistant =====
function setupAiListeners() {
    const aiModal = document.getElementById('aiModal');
    const aiInput = document.getElementById('aiInput');
    const aiResponseArea = document.getElementById('aiResponseArea');
    if (!aiModal || !aiInput) return;

    let currentAIAction = '';

    const openAiModal = (actionType) => {
        currentAIAction = actionType;
        document.getElementById('aiModalTitle').textContent = actionType === 'fix' ? '✨ Arreglar Error' : '💡 ¿Cómo añado...?';
        aiInput.value = '';
        aiInput.placeholder = actionType === 'fix'
            ? 'Describe el error que estás experimentando...'
            : '¿Qué nueva funcionalidad o estilo te gustaría añadir?';
        aiResponseArea.style.display = 'none';
        aiResponseArea.innerHTML = '';
        aiModal.classList.add('show');
        setTimeout(() => aiInput.focus(), 100);
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
                const lines = (files[fname].content || '').split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
                allCodeWithLines += `--- ARCHIVO: ${fname} ---\n${lines}\n\n`;
            });
        }

        const systemPrompt = currentAIAction === 'fix'
            ? "Eres un experto en programación web. El usuario tiene un error. Debes dar la solución indicando EXACTAMENTE el archivo, la línea y el bloque. RESPONDE SOLO USANDO ESTE FORMATO EXACTO obligatorio:\n\n[INICIO_CAMBIO]\nARCHIVO: index.html\nLINEA: 15\nBUSCAR:\n<el bloque de código original exacto (sin números de línea) que tiene el error>\nEXPLICACION: Añade esto para arreglar el div\nCODIGO:\n<el nuevo bloque de código corregido>\n[FIN_CAMBIO]\n\nImportante: SOLO ARREGLA LO QUE TE HA DICHO EL USUARIO, NADA MAS."
            : "Eres un experto web. El usuario quiere añadir algo al proyecto. RESPONDE SOLO USANDO ESTE FORMATO EXACTO obligatorio:\n\n[INICIO_CAMBIO]\nARCHIVO: style.css\nLINEA: 15\nBUSCAR:\n<bloque original sin números de línea>\nEXPLICACION: Añade este fondo\nCODIGO:\n<tu sugerencia>\n[FIN_CAMBIO]\n\nImportante: Pon ARCHIVO con exactitud, LINEA con el número y en BUSCAR exactamente el texto fuente.";

        setTimeout(() => aiModal.classList.remove('show'), 1500);

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Aquí están TODOS los archivos del proyecto CON NÚMEROS DE LÍNEA:\n\n⚠️ Estoy viendo "${currentFile}" en LÍNEA ${cursorLine}.\n\n${allCodeWithLines}\n\nPetición: ${query}` }
        ];

        try {
            const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer evxly62Xv91b752fbnHA2I3HD988C5RT',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({ model: 'mistral-large-latest', messages, stream: true })
            });

            if (!response.ok) throw new Error('API Error: ' + response.status);

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let assistantMessage = '';
            let processedChanges = 0;
            aiResponseArea.innerHTML = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                for (let line of chunk.split('\n')) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.choices?.[0]?.delta?.content) {
                                assistantMessage += data.choices[0].delta.content;

                                const blockRegex = /\[INICIO_CAMBIO\]\s*ARCHIVO:\s*([^\n]+)\s*LINEA:\s*(\d+)\s*BUSCAR:\s*([\s\S]*?)EXPLICACION:\s*([\s\S]*?)CODIGO:\s*([\s\S]*?)\[FIN_CAMBIO\]/g;
                                let match, matchCount = 0;
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
                                    .replace(/\[INICIO_CAMBIO\][\s\S]*?ARCHIVO:\s*([^\n]+)[\s\S]*?\[FIN_CAMBIO\]/g, '<div style="color:var(--accent-primary); font-weight:bold; margin-top: 10px;">✅ Sugerencia creada para el archivo <b>$1</b></div>')
                                    .replace(/\n/g, '<br>');
                                aiResponseArea.innerHTML = displayHtml;
                                aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (err) {
            aiResponseArea.innerHTML = `<span style="color:#ef4444;">Error consultando Mistral: ${err.message}</span>`;
        } finally {
            document.getElementById('submitAiBtn').disabled = false;
        }
    });
}

window.addAiSuggestionZone = function (id, lineNumber, explanation, codePart, originalSearch) {
    if (!monacoEditor) return;

    let cleanCode = codePart.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();

    monacoEditor.changeViewZones(function (changeAccessor) {
        const domNode = document.createElement('div');
        domNode.style.cssText = 'background:#1e1e2e;border:1px solid #cba6f7;border-left:4px solid #cba6f7;padding:10px;z-index:10;display:flex;flex-direction:column;gap:8px;border-radius:4px;';

        domNode.innerHTML = `
            <div style="color: #cba6f7; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M19 15l-7 7-7-7"/></svg>
                <span><b>IA Sugiere:</b> ${explanation}</span>
            </div>
            <div style="background: #11111b; padding: 10px; border-radius: 4px; font-family: monospace; color: #a6e3a1; overflow-x: auto;">
                <pre style="margin:0; white-space: pre-wrap; font-size:13px;">${cleanCode.replace(/</g, '&lt;')}</pre>
            </div>
            <div style="display: flex; gap: 10px;">
                <button style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border:none; background: #cba6f7; color: #11111b; cursor:pointer;" class="ai-apply-btn">Aplicar Cambio</button>
                <button style="padding: 4px 12px; font-size: 12px; border-radius: 4px; border:1px solid #cba6f7; background:transparent; color:#cba6f7; cursor:pointer;" class="ai-discard-btn">Descartar</button>
            </div>
        `;

        const linesOfCode = cleanCode.split('\n').length;
        const estimatedHeight = 90 + (linesOfCode * 18);

        const zoneId = changeAccessor.addZone({
            afterLineNumber: lineNumber > 1 ? lineNumber - 1 : 0,
            heightInPx: estimatedHeight,
            domNode,
            marginDomNode: null
        });

        domNode.dataset.zoneId = zoneId;
        domNode.dataset.sugId = id;

        window.activeAiZoneIds = window.activeAiZoneIds || [];
        window.activeAiZoneIds.push(zoneId);
        monacoEditor.revealLineInCenter(lineNumber);

        domNode.querySelector('.ai-apply-btn').addEventListener('click', () => applyAiSuggestion(id, zoneId));
        domNode.querySelector('.ai-discard-btn').addEventListener('click', () => removeAiSuggestion(id, zoneId));
    });
};

function applyAiSuggestion(sugId, zoneId) {
    monacoEditor.changeViewZones(changeAccessor => {
        changeAccessor.removeZone(zoneId);
        if (window.activeAiZoneIds) window.activeAiZoneIds = window.activeAiZoneIds.filter(z => z !== zoneId);
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

    monacoEditor.executeEdits('ai-suggestion', [{ range: rangeToReplace, text: cleanCode, forceMoveMarkers: true }]);
    setTimeout(() => {
        if (monacoEditor) monacoEditor.getAction('editor.action.formatDocument').run();
    }, 100);
}

function removeAiSuggestion(sugId, zoneId) {
    monacoEditor.changeViewZones(changeAccessor => {
        changeAccessor.removeZone(zoneId);
        if (window.activeAiZoneIds) window.activeAiZoneIds = window.activeAiZoneIds.filter(z => z !== zoneId);
    });

    if (window.aiSuggestionsStore && window.aiSuggestionsStore[currentFile]) {
        window.aiSuggestionsStore[currentFile] = window.aiSuggestionsStore[currentFile].filter(s => s.id !== sugId);
        renderTabs();
        renderFileList();
    }
}
