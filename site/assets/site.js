/* Copy buttons, theme toggle and gentle reveal. No network, no cookies. */
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "sakura-theme";
  var zh = (root.getAttribute("lang") || "").indexOf("zh") === 0;
  var text = zh
    ? { copy: "复制", copied: "已复制", copyLabel: "复制代码", toDusk: "暮色", toLight: "日光", toDuskLabel: "切换到暮色主题", toLightLabel: "切换到日光主题" }
    : { copy: "Copy", copied: "Copied", copyLabel: "Copy code", toDusk: "Dusk", toLight: "Light", toDuskLabel: "Switch to dusk theme", toLightLabel: "Switch to light theme" };

  root.classList.add("js");

  function readStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function writeStored(value) {
    try { localStorage.setItem(KEY, value); } catch (e) { /* storage blocked: the choice just is not remembered */ }
  }

  var saved = readStored();
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function currentTheme() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }

  function setupToggle() {
    var button = document.querySelector(".theme");
    if (!button) return;
    function paint() {
      var dark = currentTheme() === "dark";
      button.textContent = dark ? text.toLight : text.toDusk;
      button.setAttribute("aria-label", dark ? text.toLightLabel : text.toDuskLabel);
    }
    button.hidden = false;
    paint();
    button.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      writeStored(next);
      paint();
    });
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", paint);
  }

  function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(area);
    });
  }

  function addCopyButton(host, getValue) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = text.copy;
    button.setAttribute("aria-label", text.copyLabel);
    var timer = null;
    button.addEventListener("click", function () {
      copyText(getValue()).then(function () {
        button.textContent = text.copied;
        clearTimeout(timer);
        timer = setTimeout(function () { button.textContent = text.copy; }, 1800);
      }, function () { /* copy refused: leave the label alone */ });
    });
    host.appendChild(button);
    return button;
  }

  function setupCopy() {
    var blocks = document.querySelectorAll(".code");
    Array.prototype.forEach.call(blocks, function (block) {
      var pre = block.querySelector("pre");
      if (!pre) return;
      block.classList.add("has-copy");
      addCopyButton(block, function () { return pre.textContent.replace(/\n$/, ""); });
    });
    var commands = document.querySelectorAll(".cmd[data-copy]");
    Array.prototype.forEach.call(commands, function (cmd) {
      addCopyButton(cmd, function () { return cmd.getAttribute("data-copy"); });
    });
  }

  function setupReveal() {
    var items = document.querySelectorAll(".reveal");
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(items, function (el) { el.classList.add("in"); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    Array.prototype.forEach.call(items, function (el) { observer.observe(el); });
  }

  function init() {
    setupToggle();
    setupCopy();
    setupReveal();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
