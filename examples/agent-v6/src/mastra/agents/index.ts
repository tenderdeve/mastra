import { Memory } from '@mastra/memory';
import { Agent } from '@mastra/core/agent';
import { weatherInfo } from '../tools';

import { createDiscordAdapter } from '@chat-adapter/discord';

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent v6',
  instructions: `Your goal is to provide weather information for cities when requested`,
  description: `An agent that can help you get weather information for a given city`,
  model: 'openai/gpt-5.4',
  tools: {
    weatherInfo,
  },
  channels: {
    adapters: {
      discord: createDiscordAdapter(),
      // discord: {
      //   name: 'ExampleAgent',
      //   adapter: createDiscordAdapter(),
      // },
    },
    // handlers: {},
  },
  memory: new Memory({
    options: {
      observationalMemory: true,
    },
  }),
  defaultOptions: {
    heartbeat: true,
  },
  heartbeat: {
    intervalMs: 60_000,
    prompt: 'Check the weather in Vancouver and respond if there are any updates that the user should know about',
    onHeartbeat: event => {
      const { agent, channelDelivered, response, thread, timestamp } = event;
      console.log('onHeartbeat:');
      console.log({
        agent,
        channelDelivered,
        response,
        thread,
        timestamp,
      });
    },
  },
});
