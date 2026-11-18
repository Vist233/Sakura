// Sakura site: the "define only the difference" tabs and the copy buttons. Shared by the English and Chinese pages.
(() => {
  const zh = document.documentElement.lang.startsWith("zh");
  const t = zh
    ? { copy: "复制", copied: "已复制", failed: "请手动复制" }
    : { copy: "Copy", copied: "Copied", failed: "Select and copy" };

  // Variants of one createAgent call. Lines marked "+" are the difference and are shown in pink.
  const variants = {
    default: {
      label: zh ? "尚未改动" : "nothing yet",
      changes: zh ? "没有" : "nothing",
      lines: [["", "const agent = await createAgent({"], ["", "  model,"], ["", "});"]],
    },
    reviewer: {
      label: zh ? "只读" : "read only",
      changes: zh ? "工具和一条规则" : "the tools and one rule",
      lines: [
        ["", "const agent = await createAgent({"],
        ["", "  model,"],
        ["+", '  tools: ["read"],'],
        ["+", '  rules: ["Review the code. Do not modify files."],'],
        ["", "});"],
      ],
    },
    remote: {
      label: zh ? "在 SSH 上运行" : "runs over SSH",
      changes: zh ? "工具在哪里执行" : "where the tools run",
      lines: [
        ["+", 'const environment = await createSshEnvironment({ host: "agent@box", cwd: "/srv/job" });'],
        ["", ""],
        ["", "const agent = await createAgent({"],
        ["", "  model,"],
        ["+", "  environment,"],
        ["", "});"],
      ],
    },
    goal: {
      label: zh ? "需验证" : "verified",
      changes: zh ? "什么时候才算完成" : "when the work counts as done",
      lines: [
        ["", "const agent = await createAgent({"],
        ["", "  model,"],
        ["+", '  goal: { objective: "Make all tests pass", verify: "npm test" },'],
        ["", "});"],
      ],
    },
    review: {
      label: zh ? "带审查" : "reviewed",
      changes: zh ? "每次工具调用先经过检查" : "every tool call is checked first",
      lines: [
        ["", "const agent = await createAgent({"],
        ["", "  model,"],
        ["+", "  plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })],"],
        ["", "});"],
      ],
    },
  };

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const paint = (s) =>
    esc(s)
      .replace(/("[^"]*")/g, '<span class="s">$1</span>')
      .replace(/\b(const|await)\b/g, '<span class="k">$1</span>');

  function show(name) {
    const v = variants[name];
    const code = document.getElementById("diff-code");
    if (!v || !code) return;
    code.innerHTML = v.lines.map(([mark, text]) => `<span class="ln${mark ? " add" : ""}">${paint(text) || " "}</span>`).join("");
    const added = v.lines.some(([mark]) => mark);
    document.getElementById("diff-changes").textContent = v.changes;
    document.getElementById("mini-label").textContent = v.label;
    document.getElementById("mini-graft").style.opacity = added ? 1 : 0.25;
    document.querySelectorAll(".tab").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.v === name)));
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.v)));
  show("default");

  document.querySelectorAll(".copy").forEach((button) => {
    button.textContent = t.copy;
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? document.getElementById(button.dataset.copyFrom)?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = t.copied;
      } catch {
        button.textContent = t.failed;
      }
      setTimeout(() => (button.textContent = t.copy), 1400);
    });
  });
})();
