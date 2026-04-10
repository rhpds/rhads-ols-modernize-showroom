(function () {
  'use strict';

  // ── Tab Refresh on First View ─────────────────────────────────────────────
  // Refreshes iframe only on FIRST click of its tab.
  // Helps with OAuth timing issues where first login fails but second succeeds.

  function initTabRefresh() {
    try {
      if (!window.parent || window.parent === window) return;

      var parentDoc = window.parent.document;

      // Find all tab buttons - Showroom uses various selectors
      var tabButtons = parentDoc.querySelectorAll('button[role="tab"], .tab-button, [data-tab-target]');

      if (tabButtons.length === 0) {
        // Fallback: try alternative selectors
        tabButtons = parentDoc.querySelectorAll('.tabs button, nav button, [class*="tab"]');
      }

      tabButtons.forEach(function(tabBtn) {
        if (tabBtn.dataset.refreshListenerAdded) return;

        tabBtn.addEventListener('click', function() {
          // Skip if this tab has already been clicked before
          if (tabBtn.dataset.firstClickDone === 'true') return;

          // Wait for tab switch animation to complete
          setTimeout(function() {
            var frames = parentDoc.querySelectorAll('iframe');

            frames.forEach(function(frame) {
              // Check if iframe is now visible
              var isNowVisible = frame.offsetParent !== null &&
                                frame.style.display !== 'none' &&
                                !frame.hidden &&
                                frame.offsetWidth > 0 &&
                                frame.offsetHeight > 0;

              if (isNowVisible) {
                // Refresh iframe on first click only
                console.log('First click refresh for iframe:', frame.src);
                frame.src = frame.src;

                // Mark this tab as already clicked
                tabBtn.dataset.firstClickDone = 'true';
              }
            });
          }, 150);
        });

        tabBtn.dataset.refreshListenerAdded = 'true';
      });

      console.log('Tab refresh (first-click only) initialized for', tabButtons.length, 'tabs');

    } catch (e) {
      console.warn('Tab refresh init failed:', e.message);
    }
  }

  // Initialize when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTabRefresh);
  } else {
    initTabRefresh();
  }

})();
