/**
 * npm run agent -- "your request"
 *
 * Runs Nexa headlessly: useful for testing a request end to end, or for
 * driving the agent from a shell script. With no argument it starts the
 * scheduler and Telegram interface and just keeps running.
 */
import { ensureDataDirs, loadConfig, loadEnv } from '../config/config';
import { NexaAgent } from '../agent/NexaAgent';
import { TelegramBot } from '../telegram/TelegramBot';
import { isTerminal } from '../tasks/Task';
import { sleep } from '../utils/time';

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  const agent = new NexaAgent(config);
  const request = process.argv.slice(2).join(' ').trim();

  agent.activity.onEntry((entry) => {
    console.log(`${entry.clock}  ${entry.level.padEnd(7)}  ${entry.message}`);
  });

  agent.start();

  const bot = new TelegramBot(agent, agent.notifications.telegram, config.telegram);
  bot.start();

  const shutdown = async (): Promise<void> => {
    console.log('\nStopping...');
    await bot.stop();
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (!request) {
    console.log('\nNexa is running. Message your Telegram bot, or pass a request as an argument.');
    console.log('Press Ctrl+C to stop.\n');
    return;
  }

  console.log(`\nRequest: ${request}\n`);
  const response = await agent.handleRequest(request, 'system', null);
  console.log(response.text);

  if (!response.task) {
    await shutdown();
    return;
  }

  // Follow the task to a stopping point so the CLI is useful in scripts.
  const taskId = response.task.id;
  for (let i = 0; i < 300; i += 1) {
    await sleep(2000);
    const task = agent.tasks.get(taskId);
    if (!task) break;
    if (isTerminal(task.status) || task.status === 'WAITING_FOR_HUMAN' || task.status === 'WAITING_FOR_APPROVAL') {
      console.log(`\nFinished with status ${task.status}`);
      if (task.result) console.log(`\n${task.result}`);
      break;
    }
  }

  await shutdown();
}

main().catch((err: Error) => {
  console.error(`agent failed: ${err.message}`);
  process.exit(1);
});
