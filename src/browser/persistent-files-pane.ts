import type { WorkspaceDirectoryEntries } from "./workspace-root-dialog";

type PersistentFilesPaneOptions = {
  listDirectory: (
    directoryPath: string | null,
    directoriesOnly: boolean,
  ) => Promise<WorkspaceDirectoryEntries>;
};

const ROOT_STORAGE_KEY = "codex-web-active-project-root";
let updateProjectRoot: ((root: string) => void) | undefined;

export function setPersistentFilesProjectRoot(root: string): void {
  localStorage.setItem(ROOT_STORAGE_KEY, root);
  updateProjectRoot?.(root);
}

export function installPersistentFilesPane({
  listDirectory,
}: PersistentFilesPaneOptions): void {
  const start = (): void => {
    let nativePane: HTMLElement | null = null;
    let pane: HTMLElement | null = null;
    let root = localStorage.getItem(ROOT_STORAGE_KEY) ?? "/workspace";
    const expanded = new Set<string>();
    const entries = new Map<string, WorkspaceDirectoryEntries["entries"]>();

    const findNativePane = (): HTMLElement | null => {
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="Filter files..."]',
      );
      if (!input || input.closest("[data-codex-web-persistent-files]")) {
        return null;
      }
      let candidate: HTMLElement | null = input.parentElement;
      while (candidate && candidate !== document.body) {
        const rect = candidate.getBoundingClientRect();
        if (rect.right >= innerWidth - 4 && rect.width > 220 && rect.height > 240) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }
      return null;
    };

    const render = (): void => {
      if (!pane) return;
      const tree = pane.querySelector<HTMLElement>(".cw-files-tree")!;
      const filter = pane.querySelector<HTMLInputElement>("input")!.value.toLowerCase();
      tree.replaceChildren();
      const append = (folder: string, depth: number): void => {
        for (const entry of entries.get(folder) ?? []) {
          if (filter && !entry.name.toLowerCase().includes(filter)) continue;
          const row = document.createElement("button");
          row.type = "button";
          row.className = "cw-files-row";
          row.style.paddingLeft = `${12 + depth * 15}px`;
          const folderOpen = entry.type === "directory" && expanded.has(entry.path);
          row.innerHTML = `<span>${entry.type === "directory" ? (folderOpen ? "⌄" : "›") : "·"}</span><span class="cw-files-name"></span>`;
          row.querySelector(".cw-files-name")!.textContent = entry.name;
          row.title = entry.path;
          row.onclick = async () => {
            if (entry.type === "directory") {
              if (expanded.has(entry.path)) expanded.delete(entry.path);
              else {
                expanded.add(entry.path);
                if (!entries.has(entry.path)) {
                  const result = await listDirectory(entry.path, false);
                  entries.set(result.directoryPath, result.entries);
                }
              }
              render();
              return;
            }
            // Preview remains owned by the upstream desktop surface. Dispatch
            // its original file click while this independent tree stays mounted.
            const target = Array.from(
              document.querySelectorAll<HTMLElement>('button, [role="treeitem"]'),
            ).find((element) =>
              !element.closest("[data-codex-web-persistent-files]") &&
              element.textContent?.trim() === entry.name,
            );
            target?.click();
          };
          tree.append(row);
          if (folderOpen) append(entry.path, depth + 1);
        }
      };
      append(root, 0);
    };

    const refresh = async (): Promise<void> => {
      const result = await listDirectory(root, false);
      root = result.directoryPath;
      entries.set(root, result.entries);
      render();
    };

    const mount = (): void => {
      const found = findNativePane();
      if (!found) return;
      nativePane = found;
      const rect = found.getBoundingClientRect();
      if (!pane) {
        pane = document.createElement("aside");
        pane.dataset.codexWebPersistentFiles = "true";
        pane.innerHTML = `<header><strong>FILES</strong><button title="Refresh">↻</button></header><input placeholder="Filter files..." /><div class="cw-files-tree"></div>`;
        const style = document.createElement("style");
        style.textContent = `[data-codex-web-persistent-files]{background:#181818;border-left:1px solid #363636;color:#eee;font:14px ui-sans-serif,system-ui;position:fixed;z-index:70}[data-codex-web-persistent-files] header{display:flex;justify-content:space-between;padding:13px 14px 9px}[data-codex-web-persistent-files] header button{background:none;border:0;color:#ddd;font-size:17px}[data-codex-web-persistent-files] input{background:#202020;border:1px solid #444;border-radius:8px;box-sizing:border-box;color:#eee;margin:0 12px 9px;padding:9px;width:calc(100% - 24px)}.cw-files-tree{overflow:auto;height:calc(100% - 92px)}.cw-files-row{align-items:center;background:none;border:0;color:inherit;display:flex;gap:8px;min-height:31px;text-align:left;width:100%}.cw-files-row:hover{background:#303030}.cw-files-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
        document.head.append(style);
        pane.querySelector<HTMLInputElement>("input")!.oninput = render;
        pane.querySelector<HTMLButtonElement>("header button")!.onclick = () => void refresh();
        document.body.append(pane);
        void refresh();
      }
      Object.assign(pane.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      // Keep the native tree alive for preview click handling, but never show it.
      nativePane.style.visibility = "hidden";
    };

    updateProjectRoot = (nextRoot): void => {
      root = nextRoot;
      entries.clear();
      expanded.clear();
      void refresh();
    };
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    addEventListener("resize", mount);
    mount();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
