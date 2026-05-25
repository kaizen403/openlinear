"use client"

import { useRef, useCallback } from "react"
import { Mic } from "lucide-react"
import { cn } from "@/lib/utils"
import { transcribeChatAudio } from "@/lib/api/chat"
import { isWhisperHallucination } from "@/lib/audio-utils"

interface VoiceCaptureProps {
  isRecording: boolean
  setIsRecording: (v: boolean) => void
  micSupported: boolean
  setMicSupported: (v: boolean) => void
  onTranscription: (text: string) => void
}

export function VoiceCapture({
  isRecording,
  setIsRecording,
  micSupported,
  setMicSupported,
  onTranscription,
}: VoiceCaptureProps) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef<number>(0)

  const handleClick = useCallback(async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop()
      setIsRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioChunksRef.current = []
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4"
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const duration = Date.now() - recordingStartRef.current
        if (duration < 1000) return
        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        if (blob.size < 1000) return
        try {
          const { text } = await transcribeChatAudio(blob)
          if (text && !isWhisperHallucination(text.trim())) {
            onTranscription(text.trim())
          }
        } catch (err) {
          console.error("Transcription failed:", err)
        }
      }
      recordingStartRef.current = Date.now()
      recorder.start()
      setIsRecording(true)
    } catch {
      setMicSupported(false)
    }
  }, [isRecording, setIsRecording, setMicSupported, onTranscription])

  return (
    <button
      onClick={handleClick}
      disabled={!micSupported}
      className={cn(
        "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm transition-colors",
        isRecording
          ? "text-red-400 animate-pulse"
          : "text-linear-text-tertiary hover:text-linear-text-secondary hover:bg-linear-bg-tertiary",
        !micSupported && "opacity-40 cursor-not-allowed",
      )}
      aria-label={isRecording ? "Stop recording" : "Start voice input"}
    >
      <Mic className="h-3.5 w-3.5" />
    </button>
  )
}
