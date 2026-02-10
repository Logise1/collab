// ===== Firebase Configuration =====
const FIREBASE_URL = 'https://abuchat-4b8d6-default-rtdb.europe-west1.firebasedatabase.app';

// ===== State Management =====
let currentUser = null;
let currentProject = null;
let currentFile = null;
let files = {};
let isUpdatingFromFirebase = false;
let updateTimeout = null;
let userId = generateUserId();

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

// ===== Authentication =====
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

    // Login form
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        await handleLogin(username, password);
    });

    // Register form
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerPasswordConfirm').value;

        if (password !== confirmPassword) {
            showToast('Las contraseñas no coinciden', 'error');
            return;
        }

        if (password.length < 4) {
            showToast('La contraseña debe tener al menos 4 caracteres', 'warning');
            return;
        }

        await handleRegister(username, password);
    });

    // Logout
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
}

async function handleLogin(username, password) {
    try {
        const passwordHash = await hashPassword(password);
        const response = await fetch(`${FIREBASE_URL}/users/${username}.json`);
        const userData = await response.json();

        if (!userData) {
            showToast('Usuario no encontrado', 'error');
            return;
        }

        if (userData.passwordHash !== passwordHash) {
            showToast('Contraseña incorrecta', 'error');
            return;
        }

        currentUser = { username, ...userData };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        showToast(`¡Bienvenido, ${username}!`, 'success');
        showMainApp();

    } catch (error) {
        console.error('Login error:', error);
        showToast('Error al iniciar sesión', 'error');
    }
}

async function handleRegister(username, password) {
    try {
        // Check if user exists
        const checkResponse = await fetch(`${FIREBASE_URL}/users/${username}.json`);
        const existingUser = await checkResponse.json();

        if (existingUser) {
            showToast('Este usuario ya existe', 'warning');
            return;
        }

        const passwordHash = await hashPassword(password);
        const userData = {
            username,
            passwordHash,
            createdAt: Date.now(),
            projects: []
        };

        await fetch(`${FIREBASE_URL}/users/${username}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });

        currentUser = userData;
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        showToast(`¡Cuenta creada! Bienvenido, ${username}!`, 'success');
        showMainApp();

    } catch (error) {
        console.error('Register error:', error);
        showToast('Error al registrarse', 'error');
    }
}

function handleLogout() {
    currentUser = null;
    currentProject = null;
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentProject');
    location.reload();
}

function showMainApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    document.getElementById('currentUsername').textContent = currentUser.username;

    setupMainAppListeners();
    loadUserProjects();
    initializeFirebase();
}

// ===== Main App Setup =====
function setupMainAppListeners() {
    // Projects button
    document.getElementById('projectsBtn').addEventListener('click', showProjectsModal);
    document.getElementById('closeProjectsModalBtn').addEventListener('click', hideProjectsModal);

    // New project
    document.getElementById('newProjectBtn').addEventListener('click', showNewProjectModal);
    document.getElementById('closeNewProjectModalBtn').addEventListener('click', hideNewProjectModal);
    document.getElementById('cancelNewProjectBtn').addEventListener('click', hideNewProjectModal);
    document.getElementById('createProjectBtn').addEventListener('click', createProject);

    // Share project
    document.getElementById('shareBtn').addEventListener('click', showShareModal);
    document.getElementById('closeShareModalBtn').addEventListener('click', hideShareModal);
    document.getElementById('cancelShareBtn').addEventListener('click', hideShareModal);
    document.getElementById('addShareBtn').addEventListener('click', shareProject);

    // New file
    document.getElementById('newFileBtn').addEventListener('click', showNewFileModal);
    document.getElementById('closeModalBtn').addEventListener('click', hideNewFileModal);
    document.getElementById('cancelNewFileBtn').addEventListener('click', hideNewFileModal);
    document.getElementById('createFileBtn').addEventListener('click', createFile);

    // File type suggestions
    document.querySelectorAll('.file-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const extension = e.target.dataset.extension;
            const input = document.getElementById('fileNameInput');
            const currentValue = input.value.split('.')[0];
            input.value = currentValue + extension;
            input.focus();
        });
    });

    // Enter to create file
    document.getElementById('fileNameInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createFile();
    });

    // Enter to create project
    document.getElementById('projectNameInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createProject();
    });

    // Editor changes
    const editor = document.getElementById('codeEditor');
    editor.addEventListener('input', (e) => {
        if (currentFile && !isUpdatingFromFirebase) {
            files[currentFile].content = e.target.value;

            clearTimeout(updateTimeout);
            updateTimeout = setTimeout(() => {
                saveFileToFirebase(currentFile, e.target.value);
            }, 500);

            updatePreview();
        }
    });

    // Cursor position
    editor.addEventListener('click', updateCursorPosition);
    editor.addEventListener('keyup', updateCursorPosition);

    // Delete file
    document.getElementById('deleteFileBtn').addEventListener('click', deleteCurrentFile);

    // Format code
    document.getElementById('formatBtn').addEventListener('click', formatCode);

    // Refresh preview
    document.getElementById('refreshPreviewBtn').addEventListener('click', () => {
        updatePreview();
        showToast('Vista previa actualizada', 'info');
    });

    // Close modals on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('show');
        });
    });
}

// ===== Project Management =====
async function loadUserProjects() {
    try {
        const response = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects.json`);
        const projects = await response.json();

        if (projects) {
            // Load last project if exists
            const lastProjectId = localStorage.getItem('currentProject');
            if (lastProjectId && projects[lastProjectId]) {
                loadProject(lastProjectId);
            }
        }
    } catch (error) {
        console.error('Error loading projects:', error);
    }
}

function showProjectsModal() {
    const modal = document.getElementById('projectsModal');
    modal.classList.add('show');
    renderProjectsList();
}

function hideProjectsModal() {
    document.getElementById('projectsModal').classList.remove('show');
}

async function renderProjectsList() {
    const projectsList = document.getElementById('projectsList');
    projectsList.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Cargando proyectos...</p>';

    try {
        const response = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects.json`);
        const projects = await response.json();

        // Also fetch shared projects
        const sharedResponse = await fetch(`${FIREBASE_URL}/shared/${currentUser.username}.json`);
        const sharedProjects = await sharedResponse.json();

        projectsList.innerHTML = '';

        if (!projects && !sharedProjects) {
            projectsList.innerHTML = '<p style="color: var(--text-secondary); grid-column: 1/-1; text-align: center;">No tienes proyectos aún. ¡Crea uno nuevo!</p>';
            return;
        }

        // Render user's projects
        if (projects) {
            Object.keys(projects).forEach(projectId => {
                const project = projects[projectId];
                const card = createProjectCard(project, projectId, true);
                projectsList.appendChild(card);
            });
        }

        // Render shared projects
        if (sharedProjects) {
            Object.keys(sharedProjects).forEach(projectId => {
                const projectData = sharedProjects[projectId];
                const card = createProjectCard(projectData, projectId, false);
                projectsList.appendChild(card);
            });
        }

    } catch (error) {
        console.error('Error rendering projects:', error);
        projectsList.innerHTML = '<p style="color: var(--error); grid-column: 1/-1; text-align: center;">Error al cargar proyectos</p>';
    }
}

function createProjectCard(project, projectId, isOwner) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
        <h4>${project.name}</h4>
        <p>${project.description || 'Sin descripción'}</p>
        <div class="project-meta">${isOwner ? 'Tu proyecto' : `Por: ${project.owner}`}</div>
        <div class="project-card-actions">
            ${isOwner ? `<button class="btn-icon" onclick="deleteProject('${projectId}')" title="Eliminar">
                <svg width="16" height="16" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2.25 4.5H15.75" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M7.5 8.25V12.75" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M10.5 8.25V12.75" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </button>` : ''}
        </div>
    `;

    card.addEventListener('click', (e) => {
        if (!e.target.closest('.project-card-actions')) {
            loadProject(projectId);
            hideProjectsModal();
        }
    });

    return card;
}

function showNewProjectModal() {
    document.getElementById('newProjectModal').classList.add('show');
    document.getElementById('projectNameInput').focus();
}

function hideNewProjectModal() {
    document.getElementById('newProjectModal').classList.remove('show');
    document.getElementById('projectNameInput').value = '';
    document.getElementById('projectDescInput').value = '';
}

async function createProject() {
    const name = document.getElementById('projectNameInput').value.trim();
    const description = document.getElementById('projectDescInput').value.trim();

    if (!name) {
        showToast('Ingresa un nombre para el proyecto', 'warning');
        return;
    }

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
        await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${projectId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectData)
        });

        // Create default files
        const defaultFiles = {
            'index.html': {
                name: 'index.html',
                content: `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <h1>¡Hola, Mundo!</h1>
        <p>Bienvenido a ${name}</p>
        <button onclick="handleClick()">Click Me</button>
    </div>
    <script src="script.js"></script>
</body>
</html>`,
                type: 'html',
                lastModified: Date.now()
            },
            'styles.css': {
                name: 'styles.css',
                content: `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
}

.container {
    background: rgba(255, 255, 255, 0.95);
    padding: 3rem;
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    text-align: center;
}

h1 {
    font-size: 2.5rem;
    color: #667eea;
    margin-bottom: 1rem;
}

button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem 2rem;
    border-radius: 10px;
    cursor: pointer;
}`,
                type: 'css',
                lastModified: Date.now()
            },
            'script.js': {
                name: 'script.js',
                content: `function handleClick() {
    alert('¡Funciona! 🎉');
}

console.log('${name} está listo! 🚀');`,
                type: 'javascript',
                lastModified: Date.now()
            }
        };

        for (const fileName in defaultFiles) {
            const encoded = encodeFirebasePath(fileName);
            await fetch(`${FIREBASE_URL}/projects/${projectId}/files/${encoded}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(defaultFiles[fileName])
            });
        }

        showToast(`Proyecto "${name}" creado`, 'success');
        hideNewProjectModal();
        loadProject(projectId);
        hideProjectsModal();

    } catch (error) {
        console.error('Error creating project:', error);
        showToast('Error al crear proyecto', 'error');
    }
}

async function deleteProject(projectId) {
    if (!confirm('¿Estás seguro de que quieres eliminar este proyecto?')) {
        return;
    }

    try {
        await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${projectId}.json`, {
            method: 'DELETE'
        });

        await fetch(`${FIREBASE_URL}/projects/${projectId}.json`, {
            method: 'DELETE'
        });

        if (currentProject === projectId) {
            currentProject = null;
            localStorage.removeItem('currentProject');
            files = {};
            renderFileList();
            document.getElementById('currentProject').querySelector('.project-name').textContent = 'Sin proyecto';
        }

        showToast('Proyecto eliminado', 'info');
        renderProjectsList();

    } catch (error) {
        console.error('Error deleting project:', error);
        showToast('Error al eliminar proyecto', 'error');
    }
}

async function loadProject(projectId) {
    currentProject = projectId;
    localStorage.setItem('currentProject', projectId);

    try {
        // Load project info
        const response = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${projectId}.json`);
        let projectData = await response.json();

        // If not found, try shared projects
        if (!projectData) {
            const sharedResponse = await fetch(`${FIREBASE_URL}/shared/${currentUser.username}/${projectId}.json`);
            projectData = await sharedResponse.json();
        }

        if (projectData) {
            document.getElementById('currentProject').querySelector('.project-name').textContent = projectData.name;
            showToast(`Proyecto "${projectData.name}" cargado`, 'success');
        }

    } catch (error) {
        console.error('Error loading project:', error);
    }
}

// ===== Share Project =====
function showShareModal() {
    if (!currentProject) {
        showToast('Primero selecciona un proyecto', 'warning');
        return;
    }

    document.getElementById('shareModal').classList.add('show');
    renderSharedUsers();
}

function hideShareModal() {
    document.getElementById('shareModal').classList.remove('show');
    document.getElementById('shareUsernameInput').value = '';
}

async function renderSharedUsers() {
    const list = document.getElementById('sharedUsersList');
    list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.75rem;">Cargando...</p>';

    try {
        const response = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${currentProject}.json`);
        const project = await response.json();

        if (!project || !project.sharedWith || project.sharedWith.length === 0) {
            list.innerHTML = '<p style="color: var(--text-tertiary); font-size: 0.75rem;">No compartido aún</p>';
            return;
        }

        list.innerHTML = '';
        project.sharedWith.forEach(username => {
            const item = document.createElement('div');
            item.className = 'shared-user-item';
            item.innerHTML = `
                <span>${username}</span>
                <button onclick="unshareProject('${username}')">Remover</button>
            `;
            list.appendChild(item);
        });

    } catch (error) {
        console.error('Error rendering shared users:', error);
        list.innerHTML = '<p style="color: var(--error); font-size: 0.75rem;">Error al cargar</p>';
    }
}

async function shareProject() {
    const username = document.getElementById('shareUsernameInput').value.trim();

    if (!username) {
        showToast('Ingresa un nombre de usuario', 'warning');
        return;
    }

    if (username === currentUser.username) {
        showToast('No puedes compartir contigo mismo', 'warning');
        return;
    }

    try {
        // Check if user exists
        const checkUser = await fetch(`${FIREBASE_URL}/users/${username}.json`);
        const userData = await checkUser.json();

        if (!userData) {
            showToast('Usuario no encontrado', 'error');
            return;
        }

        // Get current project
        const projectResponse = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${currentProject}.json`);
        const project = await projectResponse.json();

        if (!project.sharedWith) {
            project.sharedWith = [];
        }

        if (project.sharedWith.includes(username)) {
            showToast('Ya compartido con este usuario', 'info');
            return;
        }

        project.sharedWith.push(username);

        // Update project
        await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${currentProject}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(project)
        });

        // Add to shared user's list
        await fetch(`${FIREBASE_URL}/shared/${username}/${currentProject}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(project)
        });

        showToast(`Compartido con ${username}`, 'success');
        document.getElementById('shareUsernameInput').value = '';
        renderSharedUsers();

    } catch (error) {
        console.error('Error sharing project:', error);
        showToast('Error al compartir', 'error');
    }
}

async function unshareProject(username) {
    try {
        const projectResponse = await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${currentProject}.json`);
        const project = await projectResponse.json();

        project.sharedWith = project.sharedWith.filter(u => u !== username);

        await fetch(`${FIREBASE_URL}/users/${currentUser.username}/projects/${currentProject}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(project)
        });

        await fetch(`${FIREBASE_URL}/shared/${username}/${currentProject}.json`, {
            method: 'DELETE'
        });

        showToast(`Acceso removido para ${username}`, 'info');
        renderSharedUsers();

    } catch (error) {
        console.error('Error unsharing:', error);
        showToast('Error al remover acceso', 'error');
    }
}

// ===== Firebase Real-time Sync =====
function initializeFirebase() {
    if (!currentProject) return;

    setupPresence();
    listenToFiles();
    updateConnectionStatus(true);
}

function setupPresence() {
    const presencePath = `projects/${currentProject}/presence/${userId}`;

    setInterval(() => {
        if (currentProject) {
            fetch(`${FIREBASE_URL}/${presencePath}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userId,
                    username: currentUser.username,
                    lastSeen: Date.now()
                })
            });
        }
    }, 5000);

    listenToPresence();

    window.addEventListener('beforeunload', () => {
        if (currentProject) {
            fetch(`${FIREBASE_URL}/${presencePath}.json`, {
                method: 'DELETE'
            });
        }
    });
}

function listenToPresence() {
    if (!currentProject) return;

    const eventSource = new EventSource(`${FIREBASE_URL}/projects/${currentProject}/presence.json`);

    eventSource.onmessage = (event) => {
        if (event.data === 'null') return;

        try {
            const data = JSON.parse(event.data);
            if (data.data) {
                const users = Object.values(data.data);
                const now = Date.now();
                const activeUsers = users.filter(u => now - u.lastSeen < 10000);
                updateOnlineUsers(activeUsers.length);
            }
        } catch (e) {
            console.error('Error parsing presence:', e);
        }
    };
}

function listenToFiles() {
    if (!currentProject) return;

    const eventSource = new EventSource(`${FIREBASE_URL}/projects/${currentProject}/files.json`);

    eventSource.onmessage = (event) => {
        if (event.data === 'null') {
            files = {};
            renderFileList();
            return;
        }

        try {
            const data = JSON.parse(event.data);
            if (data.data) {
                isUpdatingFromFirebase = true;

                files = {};
                Object.keys(data.data).forEach(encodedName => {
                    const decodedName = decodeFirebasePath(encodedName);
                    files[decodedName] = data.data[encodedName];
                });

                renderFileList();

                if (currentFile && files[currentFile]) {
                    const editor = document.getElementById('codeEditor');
                    const cursorPos = editor.selectionStart;
                    editor.value = files[currentFile].content || '';
                    editor.setSelectionRange(cursorPos, cursorPos);
                    updatePreview();
                }

                setTimeout(() => {
                    isUpdatingFromFirebase = false;
                }, 100);
            }
        } catch (e) {
            console.error('Error parsing files:', e);
        }
    };

    eventSource.onerror = () => {
        updateConnectionStatus(false);
    };
}

async function saveFileToFirebase(fileName, content) {
    if (isUpdatingFromFirebase || !currentProject) return;

    const syncStatus = document.getElementById('syncStatus');
    syncStatus.classList.add('syncing');
    syncStatus.querySelector('span').textContent = 'Sincronizando...';

    try {
        const fileData = {
            name: fileName,
            content: content,
            type: getFileType(fileName),
            lastModified: Date.now(),
            modifiedBy: currentUser.username
        };

        const encodedFileName = encodeFirebasePath(fileName);
        await fetch(`${FIREBASE_URL}/projects/${currentProject}/files/${encodedFileName}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fileData)
        });

        setTimeout(() => {
            syncStatus.classList.remove('syncing');
            syncStatus.querySelector('span').textContent = 'Sincronizado';
        }, 300);

    } catch (error) {
        console.error('Error saving:', error);
        showToast('Error al sincronizar', 'error');
        syncStatus.classList.remove('syncing');
    }
}

async function deleteFileFromFirebase(fileName) {
    if (!currentProject) return;

    try {
        const encodedFileName = encodeFirebasePath(fileName);
        await fetch(`${FIREBASE_URL}/projects/${currentProject}/files/${encodedFileName}.json`, {
            method: 'DELETE'
        });
    } catch (error) {
        console.error('Error deleting:', error);
        showToast('Error al eliminar archivo', 'error');
    }
}

// ===== File Management =====
function showNewFileModal() {
    if (!currentProject) {
        showToast('Primero selecciona un proyecto', 'warning');
        return;
    }
    document.getElementById('newFileModal').classList.add('show');
    document.getElementById('fileNameInput').focus();
}

function hideNewFileModal() {
    document.getElementById('newFileModal').classList.remove('show');
    document.getElementById('fileNameInput').value = '';
}

function createFile() {
    const input = document.getElementById('fileNameInput');
    const fileName = input.value.trim();

    if (!fileName) {
        showToast('Ingresa un nombre de archivo', 'warning');
        return;
    }

    if (files[fileName]) {
        showToast('Este archivo ya existe', 'warning');
        return;
    }

    const newFile = {
        name: fileName,
        content: '',
        type: getFileType(fileName),
        lastModified: Date.now(),
        modifiedBy: currentUser.username
    };

    files[fileName] = newFile;
    saveFileToFirebase(fileName, '');
    openFile(fileName);
    hideNewFileModal();
    showToast(`Archivo "${fileName}" creado`, 'success');
}

function openFile(fileName) {
    currentFile = fileName;
    const file = files[fileName];

    if (!file) return;

    const editor = document.getElementById('codeEditor');
    editor.value = file.content || '';

    document.getElementById('currentFileName').textContent = fileName;
    document.getElementById('currentFileType').textContent = file.type.toUpperCase();

    renderFileList();
    renderTabs();
    updatePreview();
}

function deleteCurrentFile() {
    if (!currentFile) {
        showToast('No hay archivo seleccionado', 'warning');
        return;
    }

    if (!confirm(`¿Eliminar "${currentFile}"?`)) {
        return;
    }

    deleteFileFromFirebase(currentFile);

    const fileNames = Object.keys(files);
    const currentIndex = fileNames.indexOf(currentFile);

    if (fileNames.length > 1) {
        const nextFile = fileNames[currentIndex + 1] || fileNames[currentIndex - 1];
        openFile(nextFile);
    } else {
        currentFile = null;
        document.getElementById('codeEditor').value = '';
        document.getElementById('currentFileName').textContent = 'Sin archivo';
        document.getElementById('currentFileType').textContent = '';
    }

    showToast('Archivo eliminado', 'info');
}

// ===== UI Rendering =====
function renderFileList() {
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';

    const sortedFiles = Object.keys(files).sort();

    sortedFiles.forEach(fileName => {
        const file = files[fileName];
        const fileItem = document.createElement('div');
        fileItem.className = `file-item ${currentFile === fileName ? 'active' : ''}`;
        fileItem.innerHTML = `
            ${getFileIcon(file.type)}
            <span class="file-name">${fileName}</span>
        `;
        fileItem.addEventListener('click', () => openFile(fileName));
        fileList.appendChild(fileItem);
    });
}

function renderTabs() {
    const tabs = document.getElementById('tabs');
    tabs.innerHTML = '';

    const openFiles = Object.keys(files).slice(0, 5);

    openFiles.forEach(fileName => {
        const tab = document.createElement('button');
        tab.className = `tab ${currentFile === fileName ? 'active' : ''}`;
        tab.innerHTML = `
            <span>${fileName}</span>
            <span class="tab-close">×</span>
        `;

        tab.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) {
                openFile(fileName);
            }
        });

        tabs.appendChild(tab);
    });
}

function updatePreview() {
    const preview = document.getElementById('preview');

    let html = files['index.html']?.content || '';
    const css = files['styles.css']?.content || '';
    const js = files['script.js']?.content || '';

    if (html) {
        if (css) {
            html = html.replace(
                /<link[^>]*href=["']styles\.css["'][^>]*>/gi,
                `<style>${css}</style>`
            );
        }

        if (js) {
            html = html.replace(
                /<script[^>]*src=["']script\.js["'][^>]*><\/script>/gi,
                `<script>${js}</script>`
            );
        }
    }

    const iframeDoc = preview.contentDocument || preview.contentWindow.document;
    iframeDoc.open();
    iframeDoc.write(html);
    iframeDoc.close();
}

// ===== Utility Functions =====
function getFileType(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    const typeMap = {
        'html': 'html',
        'css': 'css',
        'js': 'javascript',
        'json': 'json',
        'md': 'markdown'
    };
    return typeMap[ext] || 'text';
}

function getFileIcon(type) {
    const icons = {
        'html': '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 3h16v18H4z"/><path d="M8 10h8M8 14h8"/></svg>',
        'css': '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 3h16v18H4z"/><circle cx="12" cy="12" r="3"/></svg>',
        'javascript': '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 3h16v18H4z"/><path d="M8 15l4-6 4 6"/></svg>',
        'default': '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'
    };
    return icons[type] || icons.default;
}

function updateCursorPosition() {
    const editor = document.getElementById('codeEditor');
    const content = editor.value;
    const cursorPos = editor.selectionStart;

    const textBeforeCursor = content.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const lineNumber = lines.length;
    const columnNumber = lines[lines.length - 1].length + 1;

    document.getElementById('lineNumber').textContent = lineNumber;
    document.getElementById('columnNumber').textContent = columnNumber;
}

function formatCode() {
    if (!currentFile) return;

    const editor = document.getElementById('codeEditor');
    let content = editor.value;

    if (currentFile.endsWith('.html')) {
        content = formatHTML(content);
    }

    if (currentFile.endsWith('.css')) {
        content = formatCSS(content);
    }

    editor.value = content;
    files[currentFile].content = content;
    saveFileToFirebase(currentFile, content);
    showToast('Código formateado', 'success');
}

function formatHTML(html) {
    let formatted = '';
    let indent = 0;
    const lines = html.split(/>\s*</);

    lines.forEach((line, index) => {
        if (line.match(/^\/\w/)) indent--;
        formatted += '  '.repeat(Math.max(0, indent)) + (index > 0 ? '<' : '') + line + (index < lines.length - 1 ? '>' : '') + '\n';
        if (line.match(/^<?\w[^>]*[^\/]$/) && !line.startsWith('input') && !line.startsWith('img')) indent++;
    });

    return formatted.trim();
}

function formatCSS(css) {
    return css
        .replace(/\{/g, ' {\n    ')
        .replace(/\}/g, '\n}\n')
        .replace(/;/g, ';\n    ')
        .replace(/\n\s*\n/g, '\n\n');
}

function updateConnectionStatus(connected) {
    const status = document.getElementById('connectionStatus');
    const dot = status.querySelector('.status-dot');
    const text = status.querySelector('span');

    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Conectado';
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Desconectado';
    }
}

function updateOnlineUsers(count) {
    document.getElementById('userCount').textContent = count;
}

function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-message">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideInRight 0.3s reverse';
        setTimeout(() => {
            container.removeChild(toast);
        }, 300);
    }, 3000);
}
