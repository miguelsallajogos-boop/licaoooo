(() => {
  const { MessageType, messaging, wait, dom, assistants, assistantResponse } =
    AutoMcGraw;

  const IDLE_TIMEOUT_MS = 120000;
  const INPUT_TIMEOUT_MS = 10000;
  const SEND_BUTTON_TIMEOUT_MS = 3000;
  const SEND_CONFIRM_MS = 5000;
  const SEND_ATTEMPTS = 2;
  const UNSAFE_BUTTON_LABEL = /voice|dictat|speech|microphone|stop|cancel/i;
  const LOG_PREFIX = "[Auto-McGraw]";

  function isSendButton(button) {
    if (!dom.isEnabled(button)) return false;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent,
    ].join(" ");
    return !UNSAFE_BUTTON_LABEL.test(label);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toParagraphHtml(value) {
    return String(value)
      .split("\n")
      .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
      .join("");
  }

  const TEXT_LAND_CHECK_MS = 60;
  const TEXT_LAND_PROBE_LENGTH = 40;

  function selectAllContent(input) {
    try {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Ignore; the strategies below will still target the caret.
    }
  }

  // Did `value` actually reach the DOM? Used to tell a strategy that
  // silently no-opped (a framework swallowed the event) from one that
  // genuinely worked, instead of assuming success either way.
  function textLanded(input, value) {
    const trimmed = value.trim();
    if (!trimmed) return true;
    const text = (input.textContent || "").trim();
    if (!text) return false;
    const probe = trimmed.slice(0, Math.min(TEXT_LAND_PROBE_LENGTH, trimmed.length));
    return text.includes(probe);
  }

  function tryPasteEvent(input, value) {
    selectAllContent(input);
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch {
      // Try the next strategy.
    }
  }

  function tryBeforeInputEvent(input, value) {
    selectAllContent(input);
    try {
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertText",
          data: value,
        })
      );
    } catch {
      // Try the next strategy.
    }
  }

  function tryExecCommand(input, value) {
    selectAllContent(input);
    try {
      document.execCommand("insertText", false, value);
    } catch {
      // Try the next strategy.
    }
  }

  function trySetInnerHtml(input, value) {
    input.innerHTML = toParagraphHtml(value);
  }

  // ChatGPT's composer (and Gemini's/DeepSeek's) is backed by a rich-text
  // editor (e.g. Lexical) that keeps its own internal model instead of
  // reading the DOM. Overwriting innerHTML directly never reaches that
  // model: the editor still thinks it's empty, so the send button stays
  // disabled and Enter submits nothing - the question never actually
  // goes anywhere, with no visible error. Try progressively more
  // native-looking ways of editing the field, and actually check the
  // DOM after each one instead of assuming it worked.
  async function insertIntoContentEditable(input, value) {
    const strategies = [
      tryPasteEvent,
      tryBeforeInputEvent,
      tryExecCommand,
      trySetInnerHtml,
    ];

    for (const strategy of strategies) {
      strategy(input, value);
      await wait.delay(TEXT_LAND_CHECK_MS);
      if (textLanded(input, value)) {
        dom.dispatchInputEvents(input);
        return true;
      }
    }

    return false;
  }

  async function setComposerText(input, value) {
    input.focus();

    if (
      input instanceof HTMLTextAreaElement ||
      input instanceof HTMLInputElement
    ) {
      dom.setInputValue(input, value);
      return true;
    }

    if (input.isContentEditable) {
      return insertIntoContentEditable(input, value);
    }

    return false;
  }

  function getComposerText(input) {
    return typeof input.value === "string"
      ? input.value
      : input.textContent || "";
  }

  function register(id, adapter) {
    const { name } = assistants.get(id);
    const getMessageId = adapter.getMessageId || (() => null);
    const isBusy = adapter.isBusy || (() => false);
    const isGenerating = adapter.isGenerating || (() => isBusy());

    let generation = 0;
    let activeWatcher = null;

    function findSendButton() {
      for (const selector of adapter.sendSelectors) {
        let matches = [];
        try {
          matches = Array.from(document.querySelectorAll(selector));
        } catch {
          continue;
        }
        const button = matches.find(isSendButton);
        if (button) return button;
      }

      const fallback = adapter.findFallbackSendButton?.();
      return isSendButton(fallback) ? fallback : null;
    }

    function countUserMessages() {
      if (!adapter.userMessageSelector) return 0;
      return document.querySelectorAll(adapter.userMessageSelector).length;
    }

    function waitUntilSent(input, userMessages) {
      return wait.waitFor(
        () =>
          !getComposerText(input).trim() ||
          isBusy() ||
          countUserMessages() > userMessages,
        { timeout: SEND_CONFIRM_MS }
      );
    }

    async function sendPrompt(prompt) {
      const idle = await wait.waitFor(() => !isBusy(), {
        timeout: IDLE_TIMEOUT_MS,
        interval: 500,
      });
      if (!idle) {
        console.warn(LOG_PREFIX, `${name} still looks busy, sending anyway.`);
      }

      for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
        const input = await wait.waitFor(
          () => dom.queryFirst(adapter.inputSelectors),
          { timeout: INPUT_TIMEOUT_MS }
        );
        if (!input) {
          throw new Error(`Could not find the ${name} message box.`);
        }

        const userMessages = countUserMessages();
        const taken = assistantResponse.snapshot(
          adapter.getResponses(),
          getMessageId
        );

        if (!(await setComposerText(input, prompt))) {
          throw new Error(`Could not type into the ${name} message box.`);
        }

        const sendButton = await wait.waitFor(findSendButton, {
          timeout: SEND_BUTTON_TIMEOUT_MS,
        });
        if (sendButton) {
          sendButton.click();
        } else {
          dom.pressKey(input, dom.KEYS.enter);
        }

        let sent = await waitUntilSent(input, userMessages);
        if (!sent && sendButton) {
          dom.pressKey(input, dom.KEYS.enter);
          sent = await waitUntilSent(input, userMessages);
        }
        if (sent) return taken;
      }

      throw new Error(`${name} did not accept the message.`);
    }

    messaging.handle(MessageType.PING, () => ({ ok: true }));

    messaging.handle(
      MessageType.PROMPT_ASSISTANT,
      ({ prompt, requestId, replyTo }) => {
        generation += 1;
        const current = generation;
        activeWatcher?.stop();
        activeWatcher = null;

        const reply = (message) =>
          messaging
            .send({ ...message, requestId, replyTo })
            .catch((error) =>
              console.error(LOG_PREFIX, "Could not reach the extension:", error)
            );

        sendPrompt(prompt)
          .then((taken) => {
            if (current !== generation) return;
            activeWatcher = assistantResponse.watch({
              snapshot: taken,
              getResponses: adapter.getResponses,
              getNodeId: getMessageId,
              isGenerating,
              onAnswer: (answer) => {
                activeWatcher = null;
                reply({ type: MessageType.ASSISTANT_ANSWER, answer });
              },
              onTimeout: () => {
                activeWatcher = null;
                reply({
                  type: MessageType.ASSISTANT_ERROR,
                  error: `No answer was detected from ${name} within 3 minutes.`,
                });
              },
            });
          })
          .catch((error) => {
            console.error(LOG_PREFIX, "Failed to send question:", error);
            reply({
              type: MessageType.ASSISTANT_ERROR,
              error: messaging.errorMessage(error),
            });
          });
      }
    );
  }

  AutoMcGraw.assistantBridge = { register };
})();
