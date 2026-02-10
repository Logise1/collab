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

    // Editor Logic
    let editTimeout;
    const editor = document.getElementById('codeEditor');
    editor.addEventListener('input', (e) => {
        if (!currentFile || isUpdatingFromFirebase) return;

        // Local optimisitic update
        if (files[currentFile]) {
            files[currentFile].content = e.target.value;
        }

        // Debounce save
        clearTimeout(editTimeout);
        editTimeout = setTimeout(() => {
            saveFileToFirebase(currentFile, e.target.value);
        }, 500);

        // Instant preview update for smooth feeling
        if (['index.html', 'style.css', 'script.js'].includes(currentFile) || files['index.html']) {
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

// ===== Real-time Sync (WebSockets) =====
function setupRealtimeSync(projectId) {
    // 1. Listen for Files
    filesRef = db.ref(`projects/${projectId}/files`);
    filesRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            files = {};
            renderFileList();
            return;
        }

        const remoteFiles = {};
        Object.keys(data).forEach(encodedName => {
            const decodedName = decodeFirebasePath(encodedName);
            const remoteFile = data[encodedName];
            remoteFiles[decodedName] = remoteFile;

            // Check if we need to update local content
            const localFile = files[decodedName];

            // Update if:
            // 1. We don't have the file locally
            // 2. OR Remote is newer AND we are NOT currently focused on editor for this file (avoid cursor jump)
            // 3. OR It's a different file than the one currently open
            if (!localFile ||
                (currentFile !== decodedName) ||
                (remoteFile.lastModified > (localFile.lastModified || 0) && document.activeElement !== document.getElementById('codeEditor'))
            ) {

                files[decodedName] = remoteFile;

                // If it's the open file, update editor content carefully
                if (currentFile === decodedName && !isLocalDirty()) {
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

        // Handle deletions
        Object.keys(files).forEach(f => {
            if (!remoteFiles[f]) delete files[f];
        });

        // Initial open
        if (!currentFile && files['index.html']) openFile('index.html');
        else if (!currentFile && Object.keys(files).length > 0) openFile(Object.keys(files)[0]);

        renderFileList();
    });

    // 2. Presence System
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
    });
}

// ===== File Operations =====
function openFile(fileName) {
    if (!files[fileName]) return;
    currentFile = fileName;

    const file = files[fileName];
    const editor = document.getElementById('codeEditor');
    editor.value = file.content || '';

    document.getElementById('currentFileName').textContent = fileName;
    document.getElementById('currentFileType').textContent = file.type.toUpperCase();

    renderFileList();
    updatePreview();

    // Update presence immediately
    if (currentProject) {
        db.ref(`projects/${currentProject}/presence/${currentUser.uid}`).update({
            viewingFile: fileName
        });
    }
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
    const iframe = document.getElementById('preview');
    if (!files['index.html']) return;

    let html = files['index.html'].content || '';
    const css = (files['style.css'] || files['styles.css'] || {}).content || '';
    const js = (files['script.js'] || {}).content || '';

    if (css) html = html.replace('</head>', `<style>${css}</style></head>`).replace('<head>', `<head><style>${css}</style>`);
    if (js) html += `<script>${js}<\/script>`; // Simple append for robustness

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
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

        let avatars = '';
        if (viewers.length > 0) {
            avatars = `<div style="display:flex; gap:2px; margin-left:auto;">
                ${viewers.map(u => `<div title="${u.username}" style="width:16px;height:16px;border-radius:50%;background:${stringToColor(u.username)};color:white;font-size:8px;display:flex;align-items:center;justify-content:center;">${u.username[0].toUpperCase()}</div>`).join('')}
            </div>`;
        }

        item.innerHTML = `${getFileIcon(file.type)} <span class="file-name">${fileName}</span> ${avatars}`;
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
function stringToColor(str) { return '#667eea'; } // simplified
function showToast(m, t) { console.log(m); } // simplistic fallback 
function formatCode() { } // stub
function updateCursorPosition() { } // stub
function isLocalDirty() { return false; } // stub helper

// Helper to fully overwrite app.js logic
