import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type DirectoryEntry = WorkspaceDirectoryEntries["entries"][number];

type ProjectExplorerOptions = {
  listDirectory: (
    directoryPath: string | null,
    directoriesOnly: boolean,
  ) => Promise<WorkspaceDirectoryEntries>;
};

const STORAGE_KEY = "codex-web-project-explorer-root";
let setRoot: ((root: string) => void) | undefined;

export function setCurrentProjectExplorerRoot(root: string): void {
  localStorage.setItem(STORAGE_KEY, root);
  setRoot?.(root);
}

export function installProjectExplorer({
  listDirectory,
}: ProjectExplorerOptions): void {
  const install = (): void => {
    if (document.getElementById("codex-web-project-explorer")) {
      return;
    }

    const host = document.createElement("aside");
    host.id = "codex-web-project-explorer";
    host.setAttribute("aria-label", "Project explorer");
    host.innerHTML = `
      <section class="cw-explorer-panel" hidden>
        <header>
          <div><strong>EXPLORER</strong><span class="cw-explorer-root"></span></div>
          <div class="cw-explorer-actions">
            <button type="button" data-action="choose" title="Choose project folder">⌁</button>
            <button type="button" data-action="refresh" title="Refresh explorer">↻</button>
            <button type="button" data-action="close" title="Close explorer">×</button>
          </div>
        </header>
        <div class="cw-explorer-tree" role="tree" aria-label="Project files"></div>
      </section>
    `;
    document.body.append(host);

    const style = document.createElement("style");
    style.textContent = `
      #codex-web-project-explorer { font-family: ui-sans-serif, system-ui, sans-serif; }
      .cw-explorer-panel { background: #1d1d1d; border-left: 1px solid #444; bottom: 0; box-shadow: -12px 0 32px #0008; color: #e8e8e8; position: fixed; right: 0; top: 65px; width: min(42vw, 520px); z-index: 90; }
      .cw-explorer-panel header { align-items: center; border-bottom: 1px solid #424242; display: flex; font-size: 11px; justify-content: space-between; letter-spacing: .08em; padding: 10px 10px 8px 13px; }
      .cw-explorer-root { color: #a9a9a9; display: block; font-size: 10px; font-weight: normal; letter-spacing: normal; margin-top: 4px; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cw-explorer-actions { display: flex; gap: 4px; }
      .cw-explorer-actions button { background: transparent; border: 0; border-radius: 4px; color: #d0d0d0; cursor: pointer; font-size: 17px; height: 24px; width: 24px; }
      .cw-explorer-actions button:hover { background: #3a3a3a; }
      .cw-explorer-tree { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; max-height: min(60vh, 560px); overflow: auto; padding: 7px 0; }
      .cw-explorer-row { align-items: center; background: transparent; border: 0; color: inherit; cursor: default; display: flex; gap: 6px; min-height: 25px; overflow: hidden; padding: 0 10px; text-align: left; width: 100%; }
      button.cw-explorer-row { cursor: pointer; } button.cw-explorer-row:hover { background: #333; }
      .cw-explorer-caret { color: #bdbdbd; display: inline-block; text-align: center; width: 12px; } .cw-explorer-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cw-explorer-muted { color: #9b9b9b; padding: 10px 13px; }
    `;
    document.head.append(style);

    const panel = host.querySelector<HTMLElement>(".cw-explorer-panel")!;
    const tree = host.querySelector<HTMLElement>(".cw-explorer-tree")!;
    const rootLabel = host.querySelector<HTMLElement>(".cw-explorer-root")!;
    let root: string | null = localStorage.getItem(STORAGE_KEY);
    const expanded = new Set<string>();
    const entriesByPath = new Map<string, DirectoryEntry[]>();

    const loadDirectory = async (directoryPath: string): Promise<void> => {
      const response = await listDirectory(directoryPath, false);
      entriesByPath.set(response.directoryPath, response.entries);
    };

    const renderDirectory = (directoryPath: string, depth: number): HTMLElement[] => {
      const entries = entriesByPath.get(directoryPath) ?? [];
      return entries.flatMap((entry) => {
        const row =
          entry.type === "directory"
            ? document.createElement("button")
            : document.createElement("div");
        row.className = "cw-explorer-row";
        row.style.paddingLeft = `${12 + depth * 15}px`;
        row.title = entry.path;
        row.setAttribute("role", "treeitem");
        const isOpen = expanded.has(entry.path);
        row.innerHTML = `<span class="cw-explorer-caret">${entry.type === "directory" ? (isOpen ? "⌄" : "›") : ""}</span><span>${entry.type === "directory" ? "▸" : "·"}</span><span class="cw-explorer-name"></span>`;
        row.querySelector(".cw-explorer-name")!.textContent = entry.name;
        if (entry.type !== "directory") {
          return [row];
        }
        if (row instanceof HTMLButtonElement) {
          row.type = "button";
        }
        row.addEventListener("click", async () => {
          if (expanded.has(entry.path)) {
            expanded.delete(entry.path);
          } else {
            expanded.add(entry.path);
            if (!entriesByPath.has(entry.path)) {
              try {
                await loadDirectory(entry.path);
              } catch (error) {
                tree.replaceChildren(errorView(error));
                return;
              }
            }
          }
          render();
        });
        return [row, ...(isOpen ? renderDirectory(entry.path, depth + 1) : [])];
      });
    };

    const errorView = (error: unknown): HTMLElement => {
      const element = document.createElement("div");
      element.className = "cw-explorer-muted";
      element.textContent = error instanceof Error ? error.message : String(error);
      return element;
    };

    const render = (): void => {
      rootLabel.textContent = root ?? "Loading shared workspace…";
      if (!root) {
        tree.replaceChildren(errorView("Choose a project folder to browse."));
        return;
      }
      const rootEntries = entriesByPath.get(root);
      tree.replaceChildren(
        ...(rootEntries
          ? renderDirectory(root, 0)
          : [errorView("Loading files…")]),
      );
    };

    const refresh = async (): Promise<void> => {
      try {
        const response = await listDirectory(root, false);
        root = response.directoryPath;
        localStorage.setItem(STORAGE_KEY, root);
        entriesByPath.clear();
        entriesByPath.set(root, response.entries);
        render();
      } catch (error) {
        tree.replaceChildren(errorView(error));
      }
    };

    const chooseRoot = async (): Promise<void> => {
      const selected = await openSelectWorkspaceRootDialog({
        listDirectory: (directoryPath) => listDirectory(directoryPath, true),
      });
      if (selected) {
        root = selected;
        expanded.clear();
        await refresh();
      }
    };

    setRoot = async (nextRoot: string): Promise<void> => {
      root = nextRoot;
      expanded.clear();
      await refresh();
    };
    const open = (): void => {
      panel.hidden = false;
      void refresh();
    };
    host.querySelector('[data-action="close"]')!.addEventListener("click", () => {
      panel.hidden = true;
    });
    host.querySelector('[data-action="refresh"]')!.addEventListener("click", () => void refresh());
    host.querySelector('[data-action="choose"]')!.addEventListener("click", () => void chooseRoot());

    // The native desktop UI renders the Browser and Terminal actions in the
    // right-side task pane. Add Explorer in that exact action group instead of
    // a floating control, and keep trying because the pane is route-driven.
    const installAction = (): void => {
      if (document.querySelector("[data-codex-web-explorer-action]")) {
        return;
      }
      const terminal = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"]'),
      ).find((element) => element.textContent?.trim() === "Terminal");
      const actionGroup = terminal?.parentElement;
      if (!terminal || !actionGroup) {
        return;
      }
      const explorerAction = document.createElement("button");
      explorerAction.type = "button";
      explorerAction.className = terminal.className;
      explorerAction.dataset.codexWebExplorerAction = "true";
      explorerAction.innerHTML = '<span aria-hidden="true">▤</span><span>Explorer</span>';
      explorerAction.addEventListener("click", open);
      actionGroup.append(explorerAction);
    };
    installAction();
    new MutationObserver(installAction).observe(document.body, {
      childList: true,
      subtree: true,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
}
