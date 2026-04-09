(function () {
  var STORAGE_KEY = "consenthub_preferences_v1";
  var banner = document.getElementById("consenthub-banner");
  var modal = document.getElementById("consenthub-modal");
  var currentPreferences = null;

  function readPreferences() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  function writePreferences(prefs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }

  function normalizeCategory(rawCategory) {
    var value = String(rawCategory || "").toLowerCase();

    if (value === "necessary" || value === "essential") {
      return "necessary";
    }
    if (value === "analytics" || value === "statistics" || value === "performance") {
      return "analytics";
    }
    if (value === "marketing" || value === "ads" || value === "advertising") {
      return "marketing";
    }
    if (value === "all") {
      return "all";
    }

    return "unknown";
  }

  function isCategoryGranted(prefs, category) {
    var safePrefs = prefs || { necessary: true, analytics: false, marketing: false };

    if (category === "necessary") {
      return true;
    }
    if (category === "analytics") {
      return !!safePrefs.analytics;
    }
    if (category === "marketing") {
      return !!safePrefs.marketing;
    }
    if (category === "all") {
      return !!safePrefs.analytics && !!safePrefs.marketing;
    }

    return false;
  }

  function isBlockedScriptNode(scriptEl) {
    if (!scriptEl || scriptEl.tagName !== "SCRIPT") {
      return false;
    }

    if (!scriptEl.getAttribute("data-consenthub-category")) {
      return false;
    }

    if (scriptEl.getAttribute("data-consenthub-executed") === "1") {
      return false;
    }

    var typeAttr = (scriptEl.getAttribute("type") || "").toLowerCase();
    var isBlockedType = typeAttr === "text/plain" || typeAttr === "application/consenthub-blocked";
    var isBlockedFlag = scriptEl.getAttribute("data-consenthub-blocked") === "1";

    return isBlockedType || isBlockedFlag;
  }

  function executeBlockedScript(scriptEl) {
    var executable = document.createElement("script");
    var attrs = scriptEl.attributes;
    var i;

    for (i = 0; i < attrs.length; i += 1) {
      var attr = attrs[i];
      if (attr.name === "type") {
        continue;
      }
      if (attr.name === "data-consenthub-blocked") {
        continue;
      }

      executable.setAttribute(attr.name, attr.value);
    }

    executable.setAttribute("data-consenthub-executed", "1");

    if (scriptEl.src) {
      executable.src = scriptEl.src;
    } else {
      executable.text = scriptEl.text || scriptEl.textContent || "";
    }

    scriptEl.setAttribute("data-consenthub-executed", "1");
    scriptEl.parentNode.replaceChild(executable, scriptEl);
  }

  function processBlockedScripts(prefs, rootNode) {
    if (!prefs) {
      return;
    }

    var root = rootNode && rootNode.querySelectorAll ? rootNode : document;
    var scriptNodes = root.querySelectorAll("script[data-consenthub-category]:not([data-consenthub-executed='1'])");
    var i;

    for (i = 0; i < scriptNodes.length; i += 1) {
      var scriptEl = scriptNodes[i];

      if (!isBlockedScriptNode(scriptEl)) {
        continue;
      }

      var category = normalizeCategory(scriptEl.getAttribute("data-consenthub-category"));
      if (isCategoryGranted(prefs, category)) {
        executeBlockedScript(scriptEl);
      }
    }
  }

  function observeDynamicBlockedScripts() {
    if (!window.MutationObserver || !document.documentElement) {
      return;
    }

    var observer = new MutationObserver(function (mutations) {
      if (!currentPreferences) {
        return;
      }

      var i;
      for (i = 0; i < mutations.length; i += 1) {
        var mutation = mutations[i];
        var j;
        for (j = 0; j < mutation.addedNodes.length; j += 1) {
          var node = mutation.addedNodes[j];
          if (!node || node.nodeType !== 1) {
            continue;
          }

          if (node.tagName === "SCRIPT") {
            if (isBlockedScriptNode(node)) {
              var nodeCategory = normalizeCategory(node.getAttribute("data-consenthub-category"));
              if (isCategoryGranted(currentPreferences, nodeCategory)) {
                executeBlockedScript(node);
              }
            }
            continue;
          }

          processBlockedScripts(currentPreferences, node);
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function postConsentEvent(action, category) {
    if (!window.ConsentHubConfig || !window.ConsentHubConfig.proxyUrl || !window.ConsentHubConfig.proxyNonce) {
      return;
    }

    fetch(window.ConsentHubConfig.proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-consenthub-nonce": window.ConsentHubConfig.proxyNonce,
      },
      credentials: "same-origin",
      body: JSON.stringify({
        action: action,
        category: category,
      }),
    }).catch(function () {
      // Silent fail to avoid breaking user browsing.
    });
  }

  function hideBanner() {
    if (banner) {
      banner.hidden = true;
    }
  }

  function showBanner() {
    if (!banner) {
      return;
    }

    var titleEl = document.getElementById("consenthub-title");
    var textEl = document.getElementById("consenthub-text");

    if (titleEl) {
      titleEl.textContent = window.ConsentHubConfig.bannerTitle;
    }

    if (textEl) {
      textEl.textContent = window.ConsentHubConfig.bannerText;
    }

    banner.hidden = false;
  }

  function openModal() {
    var analytics = document.getElementById("consenthub-analytics");
    var marketing = document.getElementById("consenthub-marketing");
    var prefsForModal = currentPreferences || {
      necessary: true,
      analytics: !!(window.ConsentHubConfig && window.ConsentHubConfig.defaultAnalytics),
      marketing: !!(window.ConsentHubConfig && window.ConsentHubConfig.defaultMarketing),
    };

    if (analytics) {
      analytics.checked = !!prefsForModal.analytics;
    }

    if (marketing) {
      marketing.checked = !!prefsForModal.marketing;
    }

    if (modal) {
      modal.hidden = false;
    }
  }

  function closeModal() {
    if (modal) {
      modal.hidden = true;
    }
  }

  function applyConsentMode(prefs) {
    // Basic hook for Google Consent Mode integrations in site scripts.
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: "consenthub_preferences_updated",
      consent_analytics: prefs.analytics ? "granted" : "denied",
      consent_ad_storage: prefs.marketing ? "granted" : "denied",
    });
  }

  function bindEvents() {
    var accept = document.getElementById("consenthub-accept");
    var reject = document.getElementById("consenthub-reject");
    var openPrefs = document.getElementById("consenthub-open-preferences");
    var closePrefs = document.getElementById("consenthub-close-modal");
    var savePrefs = document.getElementById("consenthub-save-preferences");

    if (accept) {
      accept.addEventListener("click", function () {
        var prefs = { necessary: true, analytics: true, marketing: true };
        currentPreferences = prefs;
        writePreferences(prefs);
        applyConsentMode(prefs);
        processBlockedScripts(prefs, document);
        postConsentEvent("accept_all", "all");
        hideBanner();
        closeModal();
      });
    }

    if (reject) {
      reject.addEventListener("click", function () {
        var prefs = { necessary: true, analytics: false, marketing: false };
        currentPreferences = prefs;
        writePreferences(prefs);
        applyConsentMode(prefs);
        processBlockedScripts(prefs, document);
        postConsentEvent("reject_non_essential", "all");
        hideBanner();
        closeModal();
      });
    }

    if (openPrefs) {
      openPrefs.addEventListener("click", openModal);
    }

    if (closePrefs) {
      closePrefs.addEventListener("click", closeModal);
    }

    if (savePrefs) {
      savePrefs.addEventListener("click", function () {
        var analytics = document.getElementById("consenthub-analytics");
        var marketing = document.getElementById("consenthub-marketing");
        var prefs = {
          necessary: true,
          analytics: !!(analytics && analytics.checked),
          marketing: !!(marketing && marketing.checked),
        };

        currentPreferences = prefs;
        writePreferences(prefs);
        applyConsentMode(prefs);
        processBlockedScripts(prefs, document);

        postConsentEvent("custom_preferences", "analytics");
        postConsentEvent("custom_preferences", "marketing");

        hideBanner();
        closeModal();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var existing = readPreferences();
    var analytics = document.getElementById("consenthub-analytics");
    var marketing = document.getElementById("consenthub-marketing");

    observeDynamicBlockedScripts();
    bindEvents();

    if (existing) {
      currentPreferences = existing;
      if (analytics) {
        analytics.checked = !!existing.analytics;
      }
      if (marketing) {
        marketing.checked = !!existing.marketing;
      }
      applyConsentMode(existing);
      processBlockedScripts(existing, document);
      hideBanner();
      return;
    }

    if (analytics) {
      analytics.checked = !!(window.ConsentHubConfig && window.ConsentHubConfig.defaultAnalytics);
    }
    if (marketing) {
      marketing.checked = !!(window.ConsentHubConfig && window.ConsentHubConfig.defaultMarketing);
    }

    showBanner();
  });
})();
