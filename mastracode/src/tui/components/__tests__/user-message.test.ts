import { describe, expect, it } from 'vitest';
import { UserMessageComponent } from '../user-message.js';

describe('UserMessageComponent', () => {
  it('renders a username in the border when provided', () => {
    const component = new UserMessageComponent('hello', undefined, { username: 'Alice', currentUsername: 'Bob' });

    const output = component.render(80).join('\n');

    expect(output).toContain('Alice');
    expect(output).toContain('hello');
  });
});
