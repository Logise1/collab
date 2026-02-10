// ===== Firebase Configuration =====
const FIREBASE_URL = 'https://abuchat-4b8d6-default-rtdb.europe-west1.firebasedatabase.app';

// ===== State Management =====
let currentUser = null;
let currentProject = null;
let currentFile = null;
let files = {};
let projectUsers = {}; // Users currently in the project
let isUpdatingFromFirebase = false;
let lastSyncTime = 0;
let userId = generateUserId();

// Polling references
let filePollInterval = null;
let presencePollInterval = null;

// ===== Firebase Path Encoding =====
function encodeFirebasePath(path) {
    return path.replace(/\./g, '_DOT_')
        .replace(/\$/g, '_DOLLAR_')
        .replace(/#/g, '_HASH_')
        .replace(/\[/g, '_LBRACKET_')
        .replace(/\]/g, '_RBRACKET_')
        .replace(/\//g, '_SLASH_');
}

function decodeFirebasePath(path) {
    return path.replace(/_DOT_/g, '.')
        .replace(/_DOLLAR_/g, '$')
        .replace(/_HASH_/g, '#')
        .replace(/_LBRACKET_/g, '[')
        .replace(/_RBRACKET_/g, ']')
        .replace(/_SLASH_/g, '/');
}

// ===== Password Hashing =====
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Initialize App =====
document.addEventListener('DOMContentLoaded', () => {
    checkAuthStatus();
    setupAuthListeners();
});

// ===== Authentication & Setup =====
function checkAuthStatus() {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        showMainApp();
    }
}

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

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        await handleLogin(username, password);
    });

    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirm = document.getElementById('registerPasswordConfirm').value;
        if (password !== confirm) { showToast('Contraseñas no coinciden', 'error'); return; }
        if (password.length < 4) { showToast('Mínimo 4 caracteres', 'warning'); return; }
        await handleRegister(username, password);
    });

    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
}

async function handleLogin(username, password) {
    try {
        const passwordHash = await hashPassword(password);
        const response = await fetch(`${FIREBASE_URL}/users/${username}.json`);
        const userData = await response.json();

        if (!userData || userData.passwordHash !== passwordHash) {
            showToast('Credenciales incorrectas', 'error');
            return;
        }

        currentUser = { username, ...userData };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        showMainApp();
    } catch (error) {
        console.error(error);
        showToast('Error de conexión', 'error');
    }
}

async function handleRegister(username, password) {
    try {
        const check = await fetch(`${FIREBASE_URL}/users/${username}.json`);
        if (await check.json()) { showToast('Usuario ya existe', 'warning'); return; }

        const passwordHash = await hashPassword(password);
        const userData = { username, passwordHash, createdAt: Date.now() };

        await fetch(`${FIREBASE_URL}/users/${username}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });

        currentUser = userData;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        showMainApp();
        showToast('¡Registro exitoso!', 'success');
    } catch (e) { console.error(e); showToast('Error al registrar', 'error'); }
}

function handleLogout() {
    stopPolling();
    currentUser = null;
    currentProject = null;
    localStorage.clear();
    location.reload();
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

function setupMainAppListeners() {
    // Project & File Modals
    const bindModal = (btnId, modalId, closeIds) => {
        document.getElementById(btnId).addEventListener('click', () => {
            document.getElementById(modalId).classList.add('show');
            if (modalId === 'projectsModal') renderProjectsList();
            if (modalId === 'newProjectModal') document.getElementById('projectNameInput').focus();
            if (modalId === 'newFileModal') document.getElementById('fileNameInput').focus();
        });
        closeIds.forEach(id => {
            document.getElementById(id).addEventListener('click', () => {
                document.getElementById(modalId).classList.remove('show');
            });
        });
    };

    bindModal('projectsBtn', 'projectsModal', ['closeProjectsModalBtn']);
    bindModal('newProjectBtn', 'newProjectModal', ['closeNewProjectModalBtn', 'cancelNewProjectBtn']);
    bindModal('newFileBtn', 'newFileModal', ['closeModalBtn', 'cancelNewFileBtn']);
    bindModal('shareBtn', 'shareModal', ['closeShareModalBtn', 'cancelShareBtn']);

    // Actions
    document.getElementById('createProjectBtn').addEventListener('click', createProject);
    document.getElementById('createFileBtn').addEventListener('click', createFile);
    document.getElementById('addShareBtn').addEventListener('click', shareProject);
    document.getElementById('deleteFileBtn').addEventListener('click', deleteCurrentFile);
    document.getElementById('formatBtn').addEventListener('click', formatCode);

    document.getElementById('refreshPreviewBtn').addEventListener('click', () => {
        updatePreview();
        showToast('Vista previa actualizada', 'info');
    });

    // Editor Input with Debounce
    let editTimeout;
    const editor = document.getElementById('codeEditor');
    editor.addEventListener('input', (e) => {
        if (!currentFile || isUpdatingFromFirebase) return;

        // Update local state immediately
        if (files[currentFile]) {
            files[currentFile].content = e.target.value;
        }

        clearTimeout(editTimeout);
        editTimeout = setTimeout(() => {
            saveFileToFirebase(currentFile, e.target.value);
        }, 500); // Save after 500ms of inactivity

        // Real-time preview update
        if (files['index.html'] && (currentFile === 'index.html' || currentFile === 'style.css' || currentFile === 'script.js')) {
            updatePreview();
        }
    });

    editor.addEventListener('keyup', updateCursorPosition);
    editor.addEventListener('click', updateCursorPosition);

    // File Types
    document.querySelectorAll('.file-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const input = document.getElementById('fileNameInput');
            input.value = input.value.split('.')[0] + e.target.dataset.extension;
            input.focus();
        });
    });
}

// ===== Polling System (The Core Logic) =====
function startPolling() {
    stopPolling();

    console.log('Starting polling service...');

    // 1. Poll Files every 5 seconds
    filePollInterval = setInterval(syncFiles, 5000);

    // 2. Poll Presence every 5 seconds
    presencePollInterval = setInterval(syncPresence, 5000);

    // Initial sync
    syncFiles();
    syncPresence();
}

function stopPolling() {
    if (filePollInterval) clearInterval(filePollInterval);
    if (presencePollInterval) clearInterval(presencePollInterval);
}

// ===== Synchronization Logic =====
async function syncFiles() {
    if (!currentProject) return;

    try {
        const response = await fetch(`${FIREBASE_URL}/projects/${currentProject}/files.json`);
        const data = await response.json();

        if (!data) return;

        // Merge remote files with local
        // Note: Simple "last write wins" strategy for this demo integration
        const remoteFiles = {};
        Object.keys(data).forEach(encodedName => {
            const decodedName = decodeFirebasePath(encodedName);
            remoteFiles[decodedName] = data[encodedName];

            // If file doesn't exist locally, or remote is newer AND we are not currently typing in it
            const localFile = files[decodedName];
            const remoteFile = data[encodedName];

            if (!localFile || (remoteFile.lastModified > localFile.lastModified && document.activeElement !== document.getElementById('codeEditor'))) {
                files[decodedName] = remoteFile;

                // If this is the currently open file, update editor content
                if (currentFile === decodedName) {
                    const editor = document.getElementById('codeEditor');
                    const cursorPos = editor.selectionStart;
                    isUpdatingFromFirebase = true;
                    editor.value = remoteFile.content || '';
                    editor.setSelectionRange(cursorPos, cursorPos);
                    isUpdatingFromFirebase = false;
                    updatePreview();
                }
            }
        });

        // Remove deleted files locally
        Object.keys(files).forEach(fileName => {
            if (!remoteFiles[fileName]) {
                delete files[fileName];
                if (currentFile === fileName) {
                    currentFile = null;
                    document.getElementById('codeEditor').value = '';
                    document.getElementById('currentFileName').textContent = 'Archivo eliminado';
                }
            }
        });

        renderFileList();

    } catch (error) {
        console.error('File sync error:', error);
    }
}

async function syncPresence() {
    if (!currentProject) return;

    const presencePath = `projects/${currentProject}/presence/${userId}`;

    // 1. Send Heartbeat with current file info
    try {
        await fetch(`${FIREBASE_URL}/${presencePath}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                username: currentUser.username,
                lastSeen: Date.now(),
                viewingFile: currentFile // Critical for "who is viewing what"
            })
        });
    } catch (e) {
        console.error('Presence heartbeat error:', e);
    }

    // 2. Read Everyone's Presence
    try {
        const response = await fetch(`${FIREBASE_URL}/projects/${currentProject}/presence.json`);
        const data = await response.json();

        if (data) {
            projectUsers = data; // Store global state of users

            // Filter active users (seen in last 10s)
            const now = Date.now();
            const activeUsers = Object.values(data).filter(u => (now - u.lastSeen) < 10000);

            updateOnlineUsers(activeUsers.length);

            // Update file list avatars
            renderFileList();
        }
    } catch (e) {
        console.error('Presence read error:', e);
    }
}

// ===== Project & File Operations =====
async function createProject() {
    const name = document.getElementById('projectNameInput').value.trim();
    const description = document.getElementById('projectDescInput').value.trim();
    if (!name) return showToast('Nombre requerido', 'warning');

    const projectId = 'proj_' + Date.now();
    const projectData = {
        id: projectId,
        name,
        description,
        owner: currentUser.username,
        createdAt: Date.now(),
        sharedWith: []
    };

    try {
        // 1. Create Project Metadata
        await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${projectId}.json`, {
            method: 'PUT',
            body: JSON.stringify(projectData)
        });

        // 2. Create Default Files
        const defaultFiles = {
            'index.html': `<!DOCTYPE html>\n<html>\n<head>\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>${name}</h1>\n  <p>Editado en vivo con CollabCode</p>\n  <script src="script.js"></script>\n</body>\n</html>`,
            'style.css': `body { font-family: sans-serif; background: #f0f0f0; text-align: center; padding: 50px; } \nh1 { color: #667eea; }`,
            'script.js': `console.log('Hola desde ${name}');`
        };

        // Save files one by one to ensure they exist
        for (const [fname, content] of Object.entries(defaultFiles)) {
            const encoded = encodeFirebasePath(fname);
            const fileData = {
                name: fname,
                content: content,
                type: getFileType(fname),
                lastModified: Date.now(),
                modifiedBy: currentUser.username
            };
            await fetch(`${FIREBASE_URL}/projects/${projectId}/files/${encoded}.json`, {
                method: 'PUT',
                body: JSON.stringify(fileData)
            });
        }

        showToast(`Proyecto ${name} creado`, 'success');
        document.getElementById('newProjectModal').classList.remove('show');
        document.getElementById('projectsModal').classList.remove('show');

        // Load the new project immediately
        loadProject(projectId);

    } catch (e) {
        console.error(e);
        showToast('Error al crear proyecto', 'error');
    }
}

async function loadProject(projectId) {
    currentProject = projectId;
    localStorage.setItem('currentProject', projectId);

    // Load metadata
    try {
        // Determine if owner or shared to get name
        let response = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${projectId}.json`);
        let data = await response.json();

        if (!data) {
            // Check shared location
            response = await fetch(`${FIREBASE_URL}/shared/${currentUser.username}/${projectId}.json`);
            data = await response.json();
        }

        if (data) {
            document.getElementById('currentProject').querySelector('.project-name').textContent = data.name;
        }

        // Force complete file reload
        files = {};
        await syncFiles();

        // Open index.html by default if exists
        if (files['index.html']) {
            openFile('index.html');
        } else if (Object.keys(files).length > 0) {
            openFile(Object.keys(files)[0]);
        }

        startPolling();
        showToast('Proyecto cargado', 'success');

    } catch (e) {
        console.error('Error loading project', e);
    }
}

async function createFile() {
    const name = document.getElementById('fileNameInput').value.trim();
    if (!name) return showToast('Nombre requerido', 'warning');
    if (files[name]) return showToast('Archivo ya existe', 'warning');
    if (!currentProject) return showToast('Abre un proyecto primero', 'warning');

    await saveFileToFirebase(name, '');

    // Force poll to ensure UI sync
    await syncFiles();
    openFile(name);

    document.getElementById('newFileModal').classList.remove('show');
    document.getElementById('fileNameInput').value = '';
}

async function saveFileToFirebase(fileName, content) {
    const encoded = encodeFirebasePath(fileName);
    const fileData = {
        name: fileName,
        content: content,
        type: getFileType(fileName),
        lastModified: Date.now(),
        modifiedBy: currentUser.username
    };

    // Update local immediately so UI feels responsive
    files[fileName] = fileData;

    await fetch(`${FIREBASE_URL}/projects/${currentProject}/files/${encoded}.json`, {
        method: 'PUT',
        body: JSON.stringify(fileData)
    });

    document.getElementById('syncStatus').querySelector('span').textContent = 'Guardado';
}

function openFile(fileName) {
    if (!files[fileName]) return;

    currentFile = fileName;
    const file = files[fileName];

    const editor = document.getElementById('codeEditor');
    editor.value = file.content || '';

    document.getElementById('currentFileName').textContent = fileName;
    document.getElementById('currentFileType').textContent = file.type.toUpperCase();

    renderFileList();
    renderTabs();
    updatePreview(); // Update preview when internal file changes if necessary
}

// ===== Rendering & UI =====
function renderFileList() {
    const list = document.getElementById('fileList');
    list.innerHTML = '';

    Object.keys(files).sort().forEach(fileName => {
        const file = files[fileName];
        const isActive = currentFile === fileName;

        // Find users viewing this file
        const viewers = Object.values(projectUsers).filter(u =>
            u.viewingFile === fileName &&
            u.username !== currentUser.username &&
            (Date.now() - u.lastSeen) < 10000 // Active in last 10s
        );

        const item = document.createElement('div');
        item.className = `file-item ${isActive ? 'active' : ''}`;

        let viewersHtml = '';
        if (viewers.length > 0) {
            viewersHtml = `<div class="file-viewers" style="display:flex; margin-left:auto; gap:2px;">
                ${viewers.map(u =>
                `<div title="${u.username}" style="
                        width:20px; height:20px; 
                        background:${stringToColor(u.username)}; 
                        color:white; border-radius:50%; 
                        font-size:10px; display:flex; 
                        align-items:center; justify-content:center;
                        border: 1px solid var(--bg-secondary);
                    ">${u.username[0].toUpperCase()}</div>`
            ).join('')}
            </div>`;
        }

        item.innerHTML = `
            ${getFileIcon(file.type)}
            <span class="file-name">${fileName}</span>
            ${viewersHtml}
        `;

        item.onclick = () => openFile(fileName);
        list.appendChild(item);
    });
}

function updatePreview() {
    const iframe = document.getElementById('preview');
    if (!files['index.html']) return;

    let html = files['index.html'].content || '';
    const css = files['style.css']?.content || files['styles.css']?.content || ''; // Try both names
    const js = files['script.js']?.content || '';

    // Inject CSS
    if (css) {
        html = html.replace('</head>', `<style>${css}</style></head>`);
    } else {
        // Fallback if no head
        html += `<style>${css}</style>`;
    }

    // Inject JS (at the end of body or html)
    if (js) {
        const scriptTag = `<script>${js}<\/script>`; // Escape slash
        if (html.includes('</body>')) {
            html = html.replace('</body>', `${scriptTag}</body>`);
        } else {
            html += scriptTag;
        }
    }

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
}

// ===== Helpers =====
function getFileType(name) {
    if (name.endsWith('.html')) return 'html';
    if (name.endsWith('.css')) return 'css';
    if (name.endsWith('.js')) return 'javascript';
    return 'text';
}

function getFileIcon(type) {
    // Simple icon SVG strings
    if (type === 'html') return '<svg class="file-icon" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>';
    if (type === 'css') return '<svg class="file-icon" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';
    return '<svg class="file-icon" viewBox="0 0 24 24" stroke="currentColor" fill="none"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>';
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - c.length) + c;
}

// Minimal stubs for modal renderers if not fully implemented in prev step
function renderProjectsList() {
    const list = document.getElementById('projectsList');
    list.innerHTML = 'Cargando...';

    // Fetch user projects
    fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects.json`)
        .then(res => res.json())
        .then(data => {
            list.innerHTML = '';
            if (data) {
                Object.entries(data).forEach(([id, proj]) => {
                    const div = document.createElement('div');
                    div.className = 'project-card';
                    div.innerHTML = `<h4>${proj.name}</h4><p>${proj.description || ''}</p>`;
                    div.onclick = () => {
                        loadProject(proj.id);
                        document.getElementById('projectsModal').classList.remove('show');
                    };
                    list.appendChild(div);
                });
            } else {
                list.innerHTML = 'No tienes proyectos.';
            }
        });
}

function generateUserId() { return 'user_' + Math.random().toString(36).substr(2, 9); }
function createProjectCard() { } // handled inline
function updateOnlineUsers(n) { document.getElementById('userCount').textContent = n; }
function renderTabs() { /* Optional: implement tabs UI if needed */ }
function deleteCurrentFile() { /* impl delete */ }
function formatCode() { /* impl format */ }
function updateCursorPosition() { /* impl cursor stats */ }
function showToast(msg, type) {
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = msg;
    document.getElementById('toastContainer').appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
function shareProject() { /* impl share logic same as before but using polling */ }
