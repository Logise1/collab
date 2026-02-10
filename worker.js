
// Configuracion de Firebase
const FIREBASE_DB_URL = "https://abuchat-4b8d6-default-rtdb.europe-west1.firebasedatabase.app";

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname.split('/').filter(p => p);

        // Rutas esperadas: /view/PROJECT_ID/filename
        // Ejemplo: /view/-Njks82.../index.html

        if (path[0] !== 'view' || !path[1]) {
            return new Response("Uso: /view/PROJECT_ID/[filename]", { status: 400 });
        }

        const projectId = path[1];
        let fileName = path[2] || 'index.html'; // Por defecto index.html

        // Decodificar nombre de archivo si es necesario (el cliente suele pedir script.js limpio)
        // Pero en Firebase lo guardamos como script_DOT_js si usas la codificación antigua, 
        // OJO: Con el SDK nuevo guardamos nombres limpios 'index.html' pero la key quizas esta encodeada.
        // Revisemos tu logica de guardado: 'projects/ID/files/index_DOT_html'

        const firebaseKey = fileName.replace(/\./g, '_DOT_').replace(/\//g, '_SLASH_');

        try {
            // 1. Obtener archivo especifico desde Firebase
            const fileUrl = `${FIREBASE_DB_URL}/projects/${projectId}/files/${firebaseKey}.json`;
            const response = await fetch(fileUrl);
            const fileData = await response.json();

            if (!fileData || !fileData.content) {
                return new Response(`Archivo no encontrado: ${fileName}`, { status: 404 });
            }

            // 2. Determinar Content-Type
            let contentType = 'text/plain';
            if (fileName.endsWith('.html')) contentType = 'text/html; charset=utf-8';
            else if (fileName.endsWith('.css')) contentType = 'text/css';
            else if (fileName.endsWith('.js')) contentType = 'application/javascript';
            else if (fileName.endsWith('.json')) contentType = 'application/json';

            // 3. Modificar HTML para que las rutas relativas funcionen
            // Si el usuario pone <script src="script.js">, el navegador pedira /view/ID/script.js
            // Esto funciona AUTOMATICAMENTE porque estamos en una subruta /view/ID/ 
            // y el navegador resuelve relativo a eso. ¡Magia!

            let content = fileData.content;

            // Inyectar script de auto-reload (opcional, para refresco en tiempo real)
            if (contentType.includes('html')) {
                content += `
        <script>
          // Simple auto-reload logic listener could go here
          console.log('[Collab] Vista previa cargada desde Cloudflare Worker');
        </script>`;
            }

            return new Response(content, {
                headers: {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*' // Permitir iframe desde cualquier lado
                }
            });

        } catch (e) {
            return new Response('Error interno: ' + e.message, { status: 500 });
        }
    }
};
