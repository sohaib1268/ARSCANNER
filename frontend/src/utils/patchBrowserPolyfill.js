/**
 * patchBrowserPolyfill.js
 *
 * Fixes: "TypeError: document.getElementById(id)?.remove is not a function"
 *
 * Root cause:
 *   expo-three imports @expo/browser-polyfill, which creates a global
 *   `document` object using a custom Document/Element/Node class hierarchy.
 *   These classes are missing standard DOM methods like Element.remove(),
 *   Element.contains(), etc.
 *
 *   Meanwhile, @react-navigation/stack's CardContent.js checks:
 *     if (typeof document !== 'undefined' && document.body) { ... }
 *   and then calls document.getElementById(id)?.remove().
 *
 *   The polyfill also sets navigator.maxTouchPoints = 5, which makes
 *   CardContent.js think it's running in a mobile browser, triggering
 *   the viewport workaround code path that calls .remove().
 *
 * Solution:
 *   We set up an Object.defineProperty trap on the global object so that
 *   whenever `document` is assigned (by the polyfill or anything else),
 *   we immediately patch the document and all elements it creates to
 *   include the missing DOM methods.
 *
 * This file must be imported FIRST in App.js, before any other imports
 * that might trigger expo-three or @expo/browser-polyfill loading.
 */

// Run immediately on module evaluation
(function applyPatch() {
  // Determine the global object (works in any JS environment)
  const g =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof global !== 'undefined'
      ? global
      : typeof window !== 'undefined'
      ? window
      : {};

  /**
   * Patch an element-like object to include missing standard DOM methods.
   * Safe to call multiple times on the same object.
   */
  function patchElement(el) {
    if (!el || typeof el !== 'object') return el;

    // Track whether we already patched this object
    if (el.__domPatched) return el;

    // Element.remove() - removes the element from its parent
    if (typeof el.remove !== 'function') {
      el.remove = function () {};
    }

    // Element.contains() - checks if a node is a descendant
    if (typeof el.contains !== 'function') {
      el.contains = function () {
        return false;
      };
    }

    // Element.querySelector / querySelectorAll
    if (typeof el.querySelector !== 'function') {
      el.querySelector = function () {
        return null;
      };
    }
    if (typeof el.querySelectorAll !== 'function') {
      el.querySelectorAll = function () {
        return [];
      };
    }

    // Element.setAttribute / getAttribute
    if (typeof el.setAttribute !== 'function') {
      el.setAttribute = function (name, value) {
        this[name] = value;
      };
    }
    if (typeof el.getAttribute !== 'function') {
      el.getAttribute = function (name) {
        return this[name] !== undefined ? this[name] : null;
      };
    }

    // Node.appendChild - may be missing or incomplete
    if (typeof el.appendChild !== 'function') {
      el.appendChild = function (child) {
        return child;
      };
    }

    // Node.removeChild
    if (typeof el.removeChild !== 'function') {
      el.removeChild = function (child) {
        return child;
      };
    }

    // Node.insertBefore
    if (typeof el.insertBefore !== 'function') {
      el.insertBefore = function (newNode) {
        return newNode;
      };
    }

    // textContent property (used by style elements)
    if (!('textContent' in el)) {
      el.textContent = '';
    }

    el.__domPatched = true;
    return el;
  }

  /**
   * Wrap a document's element-creating and element-finding methods
   * so that every returned element is automatically patched.
   */
  function patchDocument(doc) {
    if (!doc || typeof doc !== 'object') return;
    if (doc.__docPatched) return;

    // Patch the document object itself and its well-known children
    patchElement(doc);
    if (doc.body) patchElement(doc.body);
    if (doc.head) patchElement(doc.head);
    if (doc.documentElement) patchElement(doc.documentElement);

    // Wrap getElementById
    const origGetById = doc.getElementById;
    if (typeof origGetById === 'function') {
      doc.getElementById = function (id) {
        const el = origGetById.call(this, id);
        return el ? patchElement(el) : el;
      };
    }

    // Wrap createElement
    const origCreate = doc.createElement;
    if (typeof origCreate === 'function') {
      doc.createElement = function (tagName) {
        const el = origCreate.call(this, tagName);
        return el ? patchElement(el) : el;
      };
    }

    // Wrap createElementNS
    const origCreateNS = doc.createElementNS;
    if (typeof origCreateNS === 'function') {
      doc.createElementNS = function (ns, tagName) {
        // The polyfill's createElementNS only takes one arg (tagName)
        // but browsers take two (namespace, tagName)
        const el = origCreateNS.call(this, tagName || ns);
        return el ? patchElement(el) : el;
      };
    }

    doc.__docPatched = true;
  }

  // If document already exists, patch it now
  if (g.document) {
    patchDocument(g.document);
  }

  // Set up a defineProperty trap to catch future assignments to
  // global.document (which happens when @expo/browser-polyfill loads)
  let _storedDocument = g.document || undefined;

  try {
    Object.defineProperty(g, 'document', {
      get() {
        return _storedDocument;
      },
      set(newDoc) {
        _storedDocument = newDoc;
        if (newDoc) {
          patchDocument(newDoc);
        }
      },
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    // defineProperty may fail if the property is already non-configurable.
    // In that case, just patch whatever we have now.
    if (g.document) {
      patchDocument(g.document);
    }
  }
})();

// Default export for explicit use if needed
export default function patchBrowserPolyfill() {
  // The patch is applied on module load via the IIFE above.
  // This function exists only as a no-op export.
}
