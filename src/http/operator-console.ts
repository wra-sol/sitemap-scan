import { OPERATOR_CONSOLE_HTML } from './operator-console-html';

export function serveOperatorConsole(): Response {
  return new Response(OPERATOR_CONSOLE_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
