import { createAppController } from './app/controller-core.js';
import { shouldAutoBootstrapDocument } from './app/dom-utils.js';

export { createAppController };
export { reduceState } from './app/state.js';
export {
  renderHistoryDialog,
  renderProjectSidebar,
  renderThreadDetail,
} from './app/render-shell.js';
export {
  findConversationTurnTarget,
  shouldAutoBootstrapDocument,
} from './app/dom-utils.js';

if (typeof window !== 'undefined' && shouldAutoBootstrapDocument(window.document)) {
  const app = createAppController();
  void app.bootstrap();
}
