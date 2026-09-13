export type ThreadManager = {
  sendRequest(method: string, params: unknown): Promise<any>;
  compactThread(threadId: string): Promise<void>;
  addNotificationCallback(
    methods: string[],
    callback: (notification: any) => void,
  ): () => void;
};

export async function compactLargeContext(
  manager: ThreadManager,
  threadId: string,
  timeoutMs = 600_000,
): Promise<void> {
  const { thread } = await manager.sendRequest("thread/read", {
    threadId,
    includeTurns: false,
  });
  // `systemError` is terminal too: app-server uses it after failures such as
  // model capacity errors and clears the running flag before publishing it.
  // `notLoaded` is also safe because thread/compact/start loads the thread.
  // Only an actually active runtime must block compaction.
  if (thread.status?.type === "active")
    throw new Error(
      "Wait for the active turn to finish before compacting image context.",
    );
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let compactionTurnId: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Context compaction is taking too long. The prompt was not sent; check the thread before retrying.",
            ),
          ),
        timeoutMs,
      );
      unsubscribe = manager.addNotificationCallback(
        ["item/started", "item/completed", "turn/completed"],
        ({ method, params }) => {
          if (params.threadId !== threadId) return;
          if (params.item?.type === "contextCompaction")
            compactionTurnId = params.turnId;
          if (
            method !== "turn/completed" ||
            !compactionTurnId ||
            params.turn.id !== compactionTurnId
          )
            return;
          if (params.turn.status === "completed") resolve();
          else
            reject(
              new Error(
                params.turn.error?.message ??
                  `Context compaction ${params.turn.status}; prompt not sent.`,
              ),
            );
        },
      );
      // The RPC response is only an acknowledgement. Wait for its terminal
      // notification, not {}, before allowing the user's turn/start.
      void manager.compactThread(threadId).catch(reject);
    });
  } finally {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  }
}
