import type { AppState, HarnessSession, HarnessTtsState } from "../../src/contracts/ui/state.js";
import { escapeHtml as esc } from "./escape-html";
import { t } from "./i18n";

export interface VoiceWorkspaceActions {
  chooseWorkspace(): void;
  startSession(goal: string): void;
  sendMessage(text: string): void;
  respondApproval(id: string, decision: "accept" | "decline" | "cancel"): void;
  answerQuestion(id: string, answer: string): void;
  stopSession(): void;
  toggleRecording(): void;
  cancelRecording(): void;
  configureTts(apiKey: string, voiceId: string, enabled: boolean): void;
  forgetTts(): void;
  stopSpeech(): void;
}

export type VoicePlaybackState = "idle" | "speaking";

const icon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

function statusLabel(session: HarnessSession): string {
  if (session.error) return t(session.error);
  return t(`harness_status_${session.status}`);
}

function approvalMarkup(session: HarnessSession): string {
  const approval = session.approval;
  if (!approval) return "";
  const fallbackReasons = ["Codex requested permission to run a command.", "Codex requested permission to apply file changes."];
  const title = approval.kind === "question"
    ? approval.title === "Codex question" ? t("Codex question") : approval.title
    : t(approval.title);
  const details = fallbackReasons.includes(approval.details) ? t(approval.details) : approval.details;
  if (approval.kind === "question") {
    return `<section class="voice-workspace-approval" aria-live="polite"><span class="voice-workspace-eyebrow">${esc(t("Codex needs your input"))}</span><h3>${esc(title)}</h3><p>${esc(details)}</p>${approval.options.length ? `<div class="voice-workspace-options">${approval.options.map((option) => `<button type="button" class="voice-workspace-option" data-answer-option="${esc(option.label)}"><strong>${esc(option.label)}</strong><small>${esc(option.description)}</small></button>`).join("")}</div>` : ""}</section>`;
  }
  return `<section class="voice-workspace-approval" aria-live="polite"><span class="voice-workspace-eyebrow">${esc(t("Approval needed"))}</span><h3>${esc(title)}</h3><p>${esc(details)}</p>${approval.kind === "command" ? `<pre class="voice-workspace-command">${approval.command ? esc(approval.command) : esc(t("The command is too long to show here. For safety, approval is unavailable."))}</pre>` : ""}${approval.working_directory ? `<small>${esc(t("Folder"))}: ${esc(approval.working_directory)}</small>` : ""}<div class="voice-workspace-approval-actions"><button type="button" class="voice-workspace-button" data-approval-decision="decline">${esc(t("Decline"))}</button><button type="button" class="voice-workspace-button primary" data-approval-decision="accept" ${approval.kind === "command" && !approval.command ? "disabled" : ""}>${esc(t("Approve once"))}</button></div></section>`;
}

function activityMarkup(session: HarnessSession): string {
  return session.activity.map((item) => `<article class="voice-workspace-item ${item.kind === "activity" ? "is-activity" : `from-${item.speaker}`}" data-activity-id="${esc(item.id)}"><div class="voice-workspace-item-heading"><strong>${esc(t(item.speaker === "you" ? "You" : item.speaker === "codex" ? "Codex" : "OpenWhisper"))}</strong>${item.streaming ? `<span class="voice-workspace-live">${esc(t("Working"))}</span>` : ""}</div><p>${esc(item.speaker === "openwhisper" && item.kind === "activity" ? t(item.text) : item.text)}${item.streaming && !item.text ? esc(t("Thinking…")) : ""}</p></article>`).join("");
}

function recordingLabel(state: AppState): string {
  if (state.status === "recording") return t("Recording · {time}", { time: `${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, "0")}` });
  if (state.status === "transcribing") return t("Transcribing …");
  if (state.status === "error") return t("Something needs attention");
  if (state.recording_available === false) return t("Voice recording unavailable");
  if (state.status === "done" && state.transcript) return t("Transcript ready to review");
  return t("Ready for voice input");
}

function agentStage(session: HarnessSession, state: AppState, tts: HarnessTtsState, playback: VoicePlaybackState): { id: string; title: string; detail: string } {
  if (session.approval) return { id: "waiting", title: t("harness_status_waiting"), detail: t("Answer Codex or approve the displayed action to continue.") };
  if (playback === "speaking") return { id: "speaking", title: t("Speaking Codex reply"), detail: t("The response is being read aloud. You can stop the speech at any time.") };
  if (tts.status === "generating") return { id: "synthesizing", title: t("Preparing spoken reply"), detail: t("ElevenLabs is turning the latest Codex response into speech.") };
  if (state.status === "recording") return { id: "listening", title: t("Listening to you"), detail: t("Your voice stays on this device while OpenWhisper records it.") };
  if (state.status === "transcribing") return { id: "transcribing", title: t("Transcribing your words"), detail: t("The selected local speech model is recognizing the recording.") };
  if (session.status === "starting" || session.status === "working") return { id: "thinking", title: t("harness_status_working"), detail: t("Live work updates and completed responses appear in the session timeline.") };
  if (session.status === "error" || state.status === "error" || tts.status === "error") return { id: "error", title: t("Something needs attention"), detail: t("Check the message below, update settings if needed, then continue.") };
  if (session.thread_id) return { id: "ready", title: t("Ready for your next instruction"), detail: t("Speak or type a follow-up. Review each transcript before sending it.") };
  return { id: "idle", title: t("Ready to begin"), detail: t("Choose a folder and set a goal. Codex starts only after you press Start.") };
}

function guideMarkup(): string {
  const steps: readonly (readonly [string, string, string])[] = [
    ["1", "Choose a folder", "Codex can edit files inside this selected workspace."],
    ["2", "Set the goal and start", "Codex starts the real work session when you press Start."],
    ["3", "Speak, review, send", "OpenWhisper transcribes locally; you decide what goes to Codex."],
    ["4", "Follow and answer", "Watch updates here. Answer questions and approve actions when asked."],
  ];
  return `<section class="voice-workspace-guide"><h2>${esc(t("How a work session works"))}</h2><ol>${steps.map(([number, title, detail]) => `<li><span>${number}</span><div><strong>${esc(t(title))}</strong><small>${esc(t(detail))}</small></div></li>`).join("")}</ol></section>`;
}

function ttsCardMarkup(tts: HarnessTtsState, playback: VoicePlaybackState): string {
  const storage = tts.storage === "system_keyring" ? t("The API key is protected by your system key store.")
    : tts.storage === "session" ? t("The API key stays in memory and is cleared when OpenWhisper closes.")
      : t("The API key is encrypted with your system key store when available.");
  const status = tts.status === "generating" ? t("Generating spoken reply…")
    : playback === "speaking" ? t("Speaking Codex reply")
      : tts.enabled ? t("Spoken replies are on") : tts.configured ? t("Voice settings saved · spoken replies off") : t("Spoken replies are off");
  return `<section class="voice-workspace-card voice-workspace-tts"><div class="voice-workspace-card-heading"><span>${esc(t("Spoken replies"))}</span><span class="voice-workspace-provider">${esc(t("ElevenLabs · optional"))}</span></div><label class="voice-workspace-toggle"><input type="checkbox" name="tts-enabled" ${tts.enabled ? "checked" : ""}><span>${esc(t("Read Codex replies aloud"))}</span></label><form id="voice-workspace-tts-form"><label for="voice-workspace-tts-key">${esc(t("ElevenLabs API key"))}</label><input id="voice-workspace-tts-key" name="tts-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(t(tts.configured ? "Leave blank to keep the saved key" : "Paste your ElevenLabs API key"))}"><label for="voice-workspace-voice-id">${esc(t("Voice ID"))}</label><input id="voice-workspace-voice-id" name="tts-voice-id" value="${esc(tts.voice_id)}" maxlength="128" autocomplete="off" spellcheck="false"><div class="voice-workspace-tts-actions"><button class="voice-workspace-button primary" type="submit">${esc(t("Save voice settings"))}</button>${tts.configured ? `<button class="voice-workspace-text-button" type="button" id="voice-workspace-forget-tts">${esc(t("Forget API key"))}</button>` : ""}</div></form><div class="voice-workspace-tts-status" role="status" aria-live="polite">${esc(status)}</div>${tts.error ? `<p class="voice-workspace-tts-error" role="alert">${esc(t(tts.error))}</p>` : ""}<p>${esc(storage)} ${esc(t("When enabled, Codex replies are sent to ElevenLabs over HTTPS and billed by character. Spoken replies start off each time the Dev app opens."))}</p>${tts.status === "generating" || playback === "speaking" ? `<button type="button" class="voice-workspace-text-button" id="voice-workspace-stop-speech">${esc(t("Stop speech"))}</button>` : ""}</section>`;
}

export function renderVoiceWorkspace(root: HTMLElement, session: HarnessSession, state: AppState, tts: HarnessTtsState,
  playback: VoicePlaybackState, actions: VoiceWorkspaceActions): void {
  const focused = document.activeElement;
  const active = focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLInputElement && ["text", "password", "search", "url", "tel"].includes(focused.type)) ? focused : undefined;
  const activeName = active && root.contains(active) ? active.name : undefined;
  const activeValue = activeName ? active?.value : undefined;
  const selectionStart = activeName && active ? active.selectionStart : null;
  const selectionEnd = activeName && active ? active.selectionEnd : null;
  const questionPending = session.approval?.kind === "question";
  const canSend = !!session.thread_id && !session.approval && !["starting", "error"].includes(session.status);
  const canRecord = state.recording_available !== false && state.status !== "transcribing" && !state.recovery_available;
  const gpuLabel = !state.gpu_supported ? t("CPU recognition")
    : state.preferences.gpu && state.gpu_available ? t("GPU acceleration on")
      : state.preferences.gpu ? t("GPU selected · waiting for device") : t("GPU acceleration off");
  const stage = agentStage(session, state, tts, playback);
  root.dataset.voiceState = stage.id;
  const guide = guideMarkup();
  const ttsCard = ttsCardMarkup(tts, playback);
  const stageCard = `<section class="voice-workspace-agent" data-state="${esc(stage.id)}"><div class="voice-workspace-agent-orb" aria-hidden="true"><span></span><span></span><i>${icon("M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01")}</i></div><div><span class="voice-workspace-eyebrow">${esc(t("OpenWhisper status"))}</span><h2>${esc(stage.title)}</h2><p>${esc(stage.detail)}</p></div></section>`;
  const error = session.error ? `<div class="voice-workspace-error" role="alert">${esc(t(session.error))}</div>` : "";
  const startForm = !session.thread_id
    ? `<form id="voice-workspace-start" class="voice-workspace-start"><label for="voice-workspace-goal">${esc(t("What should Codex work on?"))}</label><textarea id="voice-workspace-goal" name="goal" rows="3" maxlength="262144" placeholder="${esc(t("Describe the goal for this work session…"))}" ${!session.workspace || session.status === "starting" ? "disabled" : ""}></textarea>${state.status === "done" && state.transcript ? `<button type="button" id="voice-workspace-use-transcript-goal" class="voice-workspace-text-button" ${!session.workspace ? "disabled" : ""}>${esc(t("Use latest transcript as the goal"))}</button>` : ""}<div class="voice-workspace-start-footer"><small>${esc(t("Codex will work only after you start the session."))}</small><button class="voice-workspace-button primary" type="submit" ${!session.workspace || session.status === "starting" ? "disabled" : ""}>${esc(t("Start Codex session"))}</button></div></form>`
    : "";
  const compose = session.approval && session.approval.kind !== "question";
  const composeDisabled = !session.thread_id || compose || session.status === "starting" || session.status === "error";
  const inputLabel = questionPending ? t("Your answer") : t("Add an instruction");
  const placeholder = questionPending ? t("Answer Codex here, or record your answer by voice…") : t("Tell Codex what to do next…");
  const inputMarkup = questionPending && session.approval?.kind === "question" && session.approval.secret
    ? `<input id="voice-workspace-message-input" name="message" type="password" autocomplete="off" aria-label="${esc(inputLabel)}" placeholder="${esc(placeholder)}" maxlength="262144" required>`
    : `<textarea id="voice-workspace-message-input" name="message" rows="2" aria-label="${esc(inputLabel)}" placeholder="${esc(placeholder)}" maxlength="262144" ${composeDisabled ? "disabled" : ""}></textarea>`;
  const sendDisabled = composeDisabled || (questionPending ? false : !canSend);
  const workspaceName = session.workspace ?? t("Choose a folder");
  const workButton = state.status === "recording" ? t("Stop voice recording") : t("Record a voice instruction");
  root.innerHTML = `<div class="voice-workspace-shell"><aside class="voice-workspace-sidebar"><div class="voice-workspace-brand"><span class="voice-workspace-brand-mark">OW</span><div><strong>${esc(t("OpenWhisper"))}</strong><small>${esc(t("Voice work session"))}</small></div></div><div class="voice-workspace-sidebar-title"><h2>${esc(t("Harness"))}</h2><span class="voice-workspace-provider">${esc(t("Codex · local app-server"))}</span></div><div class="voice-workspace-project"><span class="voice-workspace-project-mark">${icon("M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.8 12 12l8.5-4.2M12 12v9")}</span><div><strong>${esc(workspaceName)}</strong><small>${esc(session.workspace ? t("Selected working folder") : t("No folder selected"))}</small></div></div><button type="button" id="voice-workspace-choose" class="voice-workspace-button" ${session.thread_id || session.status === "working" || session.status === "waiting" || session.status === "starting" ? "disabled" : ""}>${esc(t(session.workspace ? "Change folder" : "Choose folder"))}</button><p class="voice-workspace-scope">${esc(t("Codex can write in this folder. Requests outside it need your approval."))}</p><div class="voice-workspace-sidebar-footer"><span class="voice-workspace-status-dot ${esc(session.status)}"></span><span>${esc(statusLabel(session))}</span></div></aside><main class="voice-workspace-main"><header class="voice-workspace-heading"><div><span class="voice-workspace-eyebrow">${esc(t("Work session"))}</span><h1>${esc(session.thread_id ? t("Codex session") : t("Start a Codex session"))}</h1><p>${esc(t("Your voice becomes a message you can review before sending."))}</p></div>${session.thread_id ? `<button type="button" class="voice-workspace-button" id="voice-workspace-stop">${esc(t("Stop session"))}</button>` : ""}</header>${error}${stageCard}${guide}${startForm}${session.activity.length ? `<section class="voice-workspace-timeline" aria-label="${esc(t("Session activity"))}">${activityMarkup(session)}</section>` : !session.thread_id ? `<div class="voice-workspace-empty">${icon("M12 3v18m9-9H3")}<strong>${esc(t("One real session, connected to your selected folder"))}</strong><p>${esc(t("Choose a folder, describe a goal, then start Codex. OpenWhisper records and transcribes your voice locally."))}</p></div>` : ""}${approvalMarkup(session)}<form id="voice-workspace-message" class="voice-workspace-compose"><label for="voice-workspace-message-input">${esc(inputLabel)}</label>${inputMarkup}<div class="voice-workspace-compose-footer"><div class="voice-workspace-transcript-tools">${state.status === "done" && state.transcript ? `<button type="button" id="voice-workspace-use-transcript" class="voice-workspace-text-button">${esc(t("Use latest transcript"))}</button>` : ""}<small>${esc(t("Voice input is transcribed locally. Nothing is sent until you choose to send it."))}</small></div><button class="voice-workspace-button primary" type="submit" ${sendDisabled ? "disabled" : ""}>${esc(questionPending ? t("Send answer") : t("Send to Codex"))}</button></div></form><div class="voice-workspace-feedback" id="voice-workspace-feedback" role="status" aria-live="polite"></div></main><aside class="voice-workspace-controls"><section class="voice-workspace-card voice-workspace-voice"><div class="voice-workspace-card-heading"><span>${esc(t("Voice input"))}</span><span class="voice-workspace-local-tag">${esc(t("On-device"))}</span></div><div class="voice-workspace-mic">${icon("M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 9a7 7 0 0 1-14 0m7 7v4m-4 0h8")}</div><strong>${esc(recordingLabel(state))}</strong><div class="voice-workspace-wave" aria-hidden="true">${Array.from({ length: 25 }, (_, index) => `<i style="--bar:${8 + ((index * 13) % 28)}px"></i>`).join("")}</div><button type="button" id="voice-workspace-record" class="voice-workspace-button primary" ${!canRecord ? "disabled" : ""}>${icon("M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 9a7 7 0 0 1-14 0m7 7v4m-4 0h8")}${esc(workButton)}</button>${state.status === "recording" ? `<button type="button" id="voice-workspace-cancel-recording" class="voice-workspace-text-button">${esc(t("Discard recording"))}</button>` : ""}<p>${esc(state.recording_available === false ? t("Recording is unavailable. Check microphone permission and choose a local speech model in dictation settings.") : t("Audio stays on this device. Review the transcript before sending it to Codex."))}</p></section><section class="voice-workspace-card"><div class="voice-workspace-card-heading"><span>${esc(t("Local recognition"))}</span></div><div class="voice-workspace-model"><strong>${esc(state.models.find((model) => model.id === state.preferences.model)?.title ?? state.preferences.model)}</strong><small>${esc(gpuLabel)}</small></div><button type="button" class="voice-workspace-text-button" data-settings-view="general">${esc(t("Recognition settings"))}</button></section>${ttsCard}<section class="voice-workspace-summary"><span>${esc(t("Session summary"))}</span><p>${esc(session.approval?.kind === "question" ? t("Codex is waiting for your answer.") : session.approval ? t("Codex is waiting for your approval.") : session.status === "working" ? t("Codex is working. The session activity shows its real updates.") : session.thread_id ? t("Send another message any time to guide Codex.") : t("Start a session to see Codex updates here."))}</p></section></aside></div>`;

  if (activeName && activeValue !== undefined) {
    const restored = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${CSS.escape(activeName)}"]`);
    if (restored) {
      restored.value = activeValue;
      restored.focus();
      if (selectionStart !== null && selectionEnd !== null) restored.setSelectionRange(selectionStart, selectionEnd);
    }
  }
  root.querySelector<HTMLButtonElement>("#voice-workspace-choose")?.addEventListener("click", actions.chooseWorkspace);
  root.querySelector<HTMLButtonElement>("#voice-workspace-stop")?.addEventListener("click", actions.stopSession);
  root.querySelector<HTMLButtonElement>("#voice-workspace-record")?.addEventListener("click", actions.toggleRecording);
  root.querySelector<HTMLButtonElement>("#voice-workspace-cancel-recording")?.addEventListener("click", actions.cancelRecording);
  root.querySelector<HTMLButtonElement>("#voice-workspace-forget-tts")?.addEventListener("click", actions.forgetTts);
  root.querySelector<HTMLButtonElement>("#voice-workspace-stop-speech")?.addEventListener("click", actions.stopSpeech);
  root.querySelector<HTMLFormElement>("#voice-workspace-tts-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const keyInput = root.querySelector<HTMLInputElement>('[name="tts-api-key"]');
    const apiKey = keyInput?.value ?? "";
    if (keyInput) keyInput.value = "";
    const voiceId = root.querySelector<HTMLInputElement>('[name="tts-voice-id"]')?.value.trim() ?? "";
    const enabled = root.querySelector<HTMLInputElement>('[name="tts-enabled"]')?.checked ?? false;
    actions.configureTts(apiKey, voiceId, enabled);
  });
  root.querySelector<HTMLButtonElement>("#voice-workspace-use-transcript")?.addEventListener("click", () => {
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="message"]');
    if (input) { input.value = state.transcript; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  });
  root.querySelector<HTMLButtonElement>("#voice-workspace-use-transcript-goal")?.addEventListener("click", () => {
    const goal = root.querySelector<HTMLTextAreaElement>('[name="goal"]');
    if (goal) { goal.value = state.transcript; goal.focus(); goal.setSelectionRange(goal.value.length, goal.value.length); }
  });
  root.querySelector<HTMLFormElement>("#voice-workspace-start")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const goal = root.querySelector<HTMLTextAreaElement>('[name="goal"]')?.value ?? "";
    if (goal.trim()) actions.startSession(goal);
  });
  root.querySelector<HTMLFormElement>("#voice-workspace-message")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="message"]');
    if (!input?.value.trim()) return;
    if (session.approval?.kind === "question") actions.answerQuestion(session.approval.id, input.value);
    else actions.sendMessage(input.value);
    input.value = "";
  });
  root.querySelectorAll<HTMLButtonElement>("[data-approval-decision]").forEach((button) => button.addEventListener("click", () => {
    if (session.approval && session.approval.kind !== "question") actions.respondApproval(session.approval.id, button.dataset.approvalDecision as "accept" | "decline");
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-answer-option]").forEach((button) => button.addEventListener("click", () => {
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="message"]');
    if (input) { input.value = button.dataset.answerOption ?? ""; input.focus(); }
  }));
}
