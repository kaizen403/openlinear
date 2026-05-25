"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2, Mic, Paperclip, Send, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { transcribeChatAudio, uploadChatAttachment, type ChatAttachment } from "@/lib/api/chat";
import { isWhisperHallucination } from "@/lib/audio-utils";

interface ChatComposerProps {
  onSend: (content: string, attachmentIds?: string[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  centered?: boolean;
}

type VoiceState = "idle" | "recording" | "transcribing";

const RECORDING_MIN_DURATION_MS = 700;
const RECORDING_MIN_BYTES = 512;

function getPreferredAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function appendTranscript(existing: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) return existing;
  const trimmedExisting = existing.trimEnd();
  if (!trimmedExisting) return trimmedTranscript;
  return `${trimmedExisting} ${trimmedTranscript}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function ChatComposer({
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
  placeholder = "Ask about this project...",
  centered = false,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [micSupported, setMicSupported] = useState(() =>
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef(0);
  const voiceErrorTimeoutRef = useRef<number | null>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "56px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    return () => {
      if (voiceErrorTimeoutRef.current) {
        window.clearTimeout(voiceErrorTimeoutRef.current);
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const showVoiceError = useCallback((message: string) => {
    setVoiceError(message);
    if (voiceErrorTimeoutRef.current) {
      window.clearTimeout(voiceErrorTimeoutRef.current);
    }
    voiceErrorTimeoutRef.current = window.setTimeout(() => {
      setVoiceError(null);
      voiceErrorTimeoutRef.current = null;
    }, 2500);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isStreaming) return;
    const ids = attachments.length > 0 ? attachments.map((a) => a.id) : undefined;
    onSend(trimmed, ids);
    setValue("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "56px";
  }, [value, disabled, isStreaming, onSend, attachments]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, []);

  const handleVoiceClick = useCallback(async () => {
    if (disabled || isStreaming || voiceState === "transcribing") return;

    if (voiceState === "recording") {
      stopRecording();
      return;
    }

    if (!micSupported) {
      showVoiceError("microphone unavailable");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = getPreferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;

        const duration = Date.now() - recordingStartRef.current;
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
        audioChunksRef.current = [];

        if (duration < RECORDING_MIN_DURATION_MS || audioBlob.size < RECORDING_MIN_BYTES) {
          setVoiceState("idle");
          return;
        }

        setVoiceState("transcribing");
        try {
          const result = await transcribeChatAudio(audioBlob);
          const transcript = result.text.trim();
          if (transcript && !isWhisperHallucination(transcript)) {
            setValue((current) => appendTranscript(current, transcript));
            window.requestAnimationFrame(() => {
              resize();
              textareaRef.current?.focus();
            });
          }
        } catch {
          showVoiceError("transcription failed");
        } finally {
          setVoiceState("idle");
        }
      };

      recordingStartRef.current = Date.now();
      recorder.start();
      setVoiceError(null);
      setVoiceState("recording");
    } catch {
      setMicSupported(false);
      showVoiceError("microphone blocked");
      setVoiceState("idle");
    }
  }, [disabled, isStreaming, micSupported, resize, showVoiceError, stopRecording, voiceState]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      const uploaded: ChatAttachment[] = [];
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) continue;
        const att = await uploadChatAttachment(file);
        uploaded.push(att);
      }
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      console.error("[upload]", err);
      showVoiceError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [showVoiceError]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const helperText = (() => {
    if (voiceError) return voiceError;
    if (voiceState === "recording") return "recording...";
    if (voiceState === "transcribing") return "transcribing...";
    return "Enter to send · Shift Enter for a new line";
  })();

  return (
    <div
      className={cn(
        "w-full max-w-3xl mx-auto",
        centered && "flex flex-col items-center justify-center"
      )}
    >
      <div className="relative w-full rounded-sm border border-linear-border bg-linear-bg-secondary shadow-card">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 pr-4 text-sm text-linear-text placeholder:text-linear-text-tertiary focus:outline-none disabled:opacity-50"
          style={{ minHeight: "56px", maxHeight: "240px" }}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center gap-1.5 rounded bg-linear-bg-tertiary px-2 py-1 text-[11px] text-linear-text-secondary">
                <span className="max-w-[120px] truncate">{att.filename}</span>
                <span className="text-linear-text-tertiary">{formatFileSize(att.size)}</span>
                <button type="button" onClick={() => removeAttachment(att.id)} className="ml-0.5 text-linear-text-tertiary hover:text-linear-text">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <div className="flex items-center justify-between border-t border-linear-border px-3 py-2">
          <p
            className={cn(
              "text-[11px] text-linear-text-tertiary",
              voiceState === "recording" && "text-rose-400",
              voiceError && "text-destructive"
            )}
          >
            {helperText}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isStreaming || uploading}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-linear-text-tertiary transition-colors hover:bg-linear-bg-tertiary hover:text-linear-text disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Attach file"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleVoiceClick}
              disabled={disabled || isStreaming || !micSupported}
              className={cn(
                "relative flex h-7 w-7 items-center justify-center rounded-sm text-linear-text-tertiary transition-colors hover:bg-linear-bg-tertiary hover:text-linear-text disabled:cursor-not-allowed disabled:opacity-30",
                voiceState === "recording" && "bg-rose-500/10 text-rose-400 ring-1 ring-rose-500/25 hover:bg-rose-500/15 hover:text-rose-300"
              )}
              aria-label={voiceState === "recording" ? "Stop recording" : "Record voice"}
              aria-pressed={voiceState === "recording"}
            >
              {voiceState === "recording" && (
                <span className="absolute inset-0 rounded-sm bg-rose-500/10 animate-ping" />
              )}
              {voiceState === "transcribing" ? (
                <Loader2 className="relative h-3.5 w-3.5 animate-spin" />
              ) : (
                <Mic className="relative h-3.5 w-3.5" />
              )}
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-7 w-7 items-center justify-center rounded-sm bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                aria-label="Stop generating"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!value.trim() || disabled}
                className="flex h-7 w-7 items-center justify-center rounded-sm bg-linear-accent text-white hover:bg-linear-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
