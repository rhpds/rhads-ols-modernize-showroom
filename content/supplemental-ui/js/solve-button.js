/**
 * Solve Button - Real-time Playbook Execution
 */
(function() {
    'use strict';

    const API_BASE_URL = '/api';

    function createSolveSection(moduleName) {
        const section = document.createElement('div');
        section.className = 'solve-section';
        section.innerHTML = `
            <div class="solve-controls">
                <button class="solve-button" data-module="${moduleName}">
                    🚀 Solve Module
                </button>
            </div>
            <div class="solve-output" id="solve-output-${moduleName}" style="display:none;">
                <pre class="solve-output-content" id="solve-output-content-${moduleName}"></pre>
            </div>
        `;
        return section;
    }

    function executePlaybook(moduleName) {
        const outputDiv = document.getElementById(`solve-output-${moduleName}`);
        const outputContent = document.getElementById(`solve-output-content-${moduleName}`);
        const solveButton = document.querySelector(`.solve-button[data-module="${moduleName}"]`);

        // Show output area and clear previous content
        outputDiv.style.display = 'block';
        outputContent.textContent = '';
        solveButton.disabled = true;
        solveButton.textContent = '⏳ Running...';

        // Create EventSource for SSE
        const eventSource = new EventSource(`${API_BASE_URL}/solve/${moduleName}`);

        eventSource.onmessage = function(event) {
            try {
                const line = JSON.parse(event.data);
                outputContent.textContent += line;
            } catch (e) {
                outputContent.textContent += event.data + '\n';
            }
            // Auto-scroll to bottom to follow output
            outputDiv.scrollTop = outputDiv.scrollHeight;
        };

        eventSource.onerror = function(error) {
            console.error('SSE Error:', error);
            eventSource.close();
            solveButton.disabled = false;
            solveButton.textContent = '🚀 Solve Module';
            outputContent.textContent += '\n❌ Connection closed\n';
        };

        // Close connection after completion
        setTimeout(() => {
            eventSource.close();
            solveButton.disabled = false;
            solveButton.textContent = '🚀 Solve Module';
        }, 60000); // 60 second timeout
    }

    // Initialize solve buttons on page load
    document.addEventListener('DOMContentLoaded', function() {
        // Find all solve-button-placeholder divs
        const placeholders = document.querySelectorAll('.solve-button-placeholder');

        placeholders.forEach(placeholder => {
            const moduleName = placeholder.getAttribute('data-module');
            const solveSection = createSolveSection(moduleName);
            placeholder.replaceWith(solveSection);
        });

        // Add event listeners
        document.querySelectorAll('.solve-button').forEach(button => {
            button.addEventListener('click', function() {
                const moduleName = this.getAttribute('data-module');
                executePlaybook(moduleName);
            });
        });
    });
})();
