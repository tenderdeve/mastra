import { Container, Spacer, Text } from '@mariozechner/pi-tui';
import { BOX_INDENT, theme } from '../theme.js';

export class PendingUserMessageComponent extends Container {
  constructor(text: string, imageCount = 0) {
    super();

    const prefix = imageCount > 0 ? `[${imageCount} image${imageCount > 1 ? 's' : ''}] ` : '';
    const displayText = `${prefix}${text.replace(/\[image\]\s*/g, '').trim()}`.trim();
    this.addChild(new Text(theme.fg('dim', `↳ ${displayText || 'Message'} pending…`), BOX_INDENT, 0));
    this.addChild(new Spacer(1));
  }
}
