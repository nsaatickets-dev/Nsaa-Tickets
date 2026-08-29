(function () {
  // Promise-based dialog component, replacing window.confirm/prompt/alert.
  // Loaded after nsaa.js (window.NSAA must already exist) - extends the
  // same flat NSAA.* namespace rather than introducing a second one.
  // Mirrors nsaa.js's initNavToggle() for focus/Escape/click-outside
  // handling: plain addEventListener, no framework.

  let overlayEl = null;
  let modalEl = null;
  let lastFocusedEl = null;

  function ensureRoot() {
    if (overlayEl) return;

    overlayEl = document.createElement("div");
    overlayEl.className = "nsaa-modal-overlay";
    overlayEl.setAttribute("role", "presentation");
    overlayEl.hidden = true;
    document.body.appendChild(overlayEl);

    modalEl = document.createElement("div");
    modalEl.className = "nsaa-modal";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    overlayEl.appendChild(modalEl);
  }

  function focusableElements() {
    return Array.from(
      modalEl.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.disabled && el.offsetParent !== null);
  }

  function trapTab(event) {
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Opens the shared overlay with the given inner markup and wires up
  // Escape/backdrop/close-button/focus-trap. `resolve(value)` is called by
  // the caller-supplied bindings; this function only owns open/close
  // lifecycle, not the dialog's semantics (confirm vs prompt vs alert).
  function open(bodyHtml, { tone } = {}) {
    ensureRoot();
    lastFocusedEl = document.activeElement;

    modalEl.innerHTML = bodyHtml;
    modalEl.dataset.tone = tone || "default";
    overlayEl.hidden = false;
    document.body.classList.add("nsaa-modal-open");
    // Force a reflow so the initial (opacity:0) state is committed before
    // adding is-open, so the transition actually animates. requestAnimationFrame
    // would be the usual tool here, but it's throttled/paused in a hidden or
    // backgrounded tab, which could leave the dialog stuck invisible.
    void overlayEl.offsetHeight;
    overlayEl.classList.add("is-open");

    const autofocusEl = modalEl.querySelector("[autofocus]") || focusableElements()[0];
    if (autofocusEl) autofocusEl.focus();

    document.addEventListener("keydown", onKeydown);
    overlayEl.addEventListener("click", onOverlayClick);
  }

  function close() {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.classList.remove("is-open");
    document.body.classList.remove("nsaa-modal-open");
    document.removeEventListener("keydown", onKeydown);
    overlayEl.removeEventListener("click", onOverlayClick);
    overlayEl.hidden = true;
    modalEl.innerHTML = "";
    if (lastFocusedEl && typeof lastFocusedEl.focus === "function") {
      lastFocusedEl.focus();
    }
  }

  let onCancel = null;

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (onCancel) onCancel();
      return;
    }
    trapTab(event);
  }

  function onOverlayClick(event) {
    if (event.target === overlayEl && onCancel) onCancel();
  }

  function dialogShell({ title, bodyHtml, footerHtml }) {
    return `
      <div class="nsaa-modal-header">
        <h2 class="h5">${NSAA.escapeHtml(title)}</h2>
        <button type="button" class="nsaa-modal-close" data-modal-cancel aria-label="Close">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="nsaa-modal-body">${bodyHtml}</div>
      <div class="nsaa-modal-footer">${footerHtml}</div>
    `;
  }

  function confirmDialog({
    title,
    body = "",
    confirmLabel = "Continue",
    cancelLabel = "Cancel",
    tone = "default",
  } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        onCancel = null;
        close();
        resolve(value);
      };

      onCancel = () => finish(false);

      open(
        dialogShell({
          title,
          bodyHtml: body ? `<p>${NSAA.escapeHtml(body)}</p>` : "",
          footerHtml: `
            <button type="button" class="btn btn-outline-nsaa" data-modal-cancel>${NSAA.escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-nsaa nsaa-modal-confirm" data-modal-confirm autofocus>${NSAA.escapeHtml(confirmLabel)}</button>
          `,
        }),
        { tone },
      );

      modalEl.querySelectorAll("[data-modal-cancel]").forEach((el) =>
        el.addEventListener("click", () => finish(false)),
      );
      modalEl.querySelector("[data-modal-confirm]").addEventListener("click", () => finish(true));
    });
  }

  function alertDialog({ title, body = "", confirmLabel = "OK" } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        onCancel = null;
        close();
        resolve();
      };

      onCancel = finish;

      open(
        dialogShell({
          title,
          bodyHtml: body ? `<p>${NSAA.escapeHtml(body)}</p>` : "",
          footerHtml: `<button type="button" class="btn btn-nsaa" data-modal-confirm autofocus>${NSAA.escapeHtml(confirmLabel)}</button>`,
        }),
      );

      modalEl.querySelector("[data-modal-confirm]").addEventListener("click", finish);
    });
  }

  function promptDialog({
    title,
    body = "",
    label = "",
    placeholder = "",
    defaultValue = "",
    required = true,
    multiline = false,
    readonly = false,
    validate = null,
    confirmLabel = "Continue",
    cancelLabel = "Cancel",
    tone = "default",
  } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        onCancel = null;
        close();
        resolve(value);
      };

      onCancel = () => finish(null);

      const inputTag = multiline
        ? `<textarea class="form-control form-control-nsaa" id="nsaa-modal-input" rows="3" placeholder="${NSAA.escapeAttr(placeholder)}" ${readonly ? "readonly" : ""} autofocus>${NSAA.escapeHtml(defaultValue)}</textarea>`
        : `<input class="form-control form-control-nsaa" id="nsaa-modal-input" type="text" value="${NSAA.escapeAttr(defaultValue)}" placeholder="${NSAA.escapeAttr(placeholder)}" ${readonly ? "readonly" : ""} autofocus />`;

      open(
        dialogShell({
          title,
          bodyHtml: `
            ${body ? `<p>${NSAA.escapeHtml(body)}</p>` : ""}
            ${label ? `<label class="nsaa-muted small" for="nsaa-modal-input">${NSAA.escapeHtml(label)}</label>` : ""}
            ${inputTag}
            <p class="nsaa-modal-error" data-modal-input-error hidden></p>
          `,
          footerHtml: `
            <button type="button" class="btn btn-outline-nsaa" data-modal-cancel>${NSAA.escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-nsaa nsaa-modal-confirm" data-modal-confirm>${NSAA.escapeHtml(confirmLabel)}</button>
          `,
        }),
        { tone },
      );

      const inputEl = modalEl.querySelector("#nsaa-modal-input");
      const errorEl = modalEl.querySelector("[data-modal-input-error]");
      if (readonly) inputEl.select();

      function submit() {
        const value = inputEl.value.trim();
        if (required && !value) {
          errorEl.textContent = "This field is required.";
          errorEl.hidden = false;
          return;
        }
        if (validate) {
          const error = validate(value);
          if (error) {
            errorEl.textContent = error;
            errorEl.hidden = false;
            return;
          }
        }
        finish(value);
      }

      modalEl.querySelectorAll("[data-modal-cancel]").forEach((el) =>
        el.addEventListener("click", () => finish(null)),
      );
      modalEl.querySelector("[data-modal-confirm]").addEventListener("click", submit);
      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !multiline) {
          event.preventDefault();
          submit();
        }
      });
    });
  }

  window.NSAA = window.NSAA || {};
  Object.assign(window.NSAA, { confirmDialog, alertDialog, promptDialog });
})();
