export const activeAiTasks = new Map();
export const aiStopRequests = new Set();

const taskControllers = new Map();
let taskCounter = 0;

export function getStopKey(ctx) {
  const selfId = ctx?.self_id || ctx?.me?.id || "default";
  const userId = ctx?.user_id || ctx?.from?.id || "unknown";
  const groupId = ctx?.group_id;
  return groupId
    ? `bot:${selfId}:group:${groupId}:user:${userId}`
    : `bot:${selfId}:private:${userId}`;
}

export function startAiTask(ctx) {
  const key = getStopKey(ctx);
  const taskId = `ai-task-${Date.now()}-${++taskCounter}`;
  const tasks = activeAiTasks.get(key) || new Set();
  tasks.add(taskId);
  activeAiTasks.set(key, tasks);
  taskControllers.set(taskId, new AbortController());
  return taskId;
}

/** Signal aborted when the user asks to stop this task; streams cancel on it. */
export function getAiTaskSignal(taskId) {
  return taskControllers.get(taskId)?.signal || null;
}

export function finishAiTask(ctx, taskId) {
  if (!taskId) return;
  aiStopRequests.delete(taskId);
  taskControllers.delete(taskId);
  const key = getStopKey(ctx);
  const tasks = activeAiTasks.get(key);
  if (!tasks) return;
  tasks.delete(taskId);
  if (tasks.size === 0) activeAiTasks.delete(key);
}

export function requestStopCurrentTasks(ctx) {
  const tasks = activeAiTasks.get(getStopKey(ctx));
  if (!tasks?.size) return false;
  for (const taskId of tasks) {
    aiStopRequests.add(taskId);
    taskControllers.get(taskId)?.abort();
  }
  return true;
}

export function checkAndClearStopFlag(taskId) {
  if (!taskId || !aiStopRequests.has(taskId)) return false;
  aiStopRequests.delete(taskId);
  return true;
}
