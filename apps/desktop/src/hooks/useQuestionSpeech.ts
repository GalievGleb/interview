import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  QuestionSpeechLoader,
  waitForFallbackVoice,
} from '../lib/questionSpeech';

export type QuestionSpeechState = 'idle' | 'loading' | 'playing' | 'error';

export interface QuestionSpeechController {
  state: QuestionSpeechState;
  usedFallback: boolean;
  play(text: string, language: 'ru' | 'en'): Promise<void>;
  stop(): void;
  prefetch(text: string | undefined, language: 'ru' | 'en'): void;
}

export function useQuestionSpeech(): QuestionSpeechController {
  const loaderRef = useRef<QuestionSpeechLoader | null>(null);
  if (!loaderRef.current) {
    loaderRef.current = new QuestionSpeechLoader((text, language) =>
      api.synthesizeSpeech(text, language),
    );
  }
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const generationRef = useRef(0);
  const [state, setState] = useState<QuestionSpeechState>('idle');
  const [usedFallback, setUsedFallback] = useState(false);

  const stop = useCallback(() => {
    generationRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    window.speechSynthesis?.cancel();
    setUsedFallback(false);
    setState('idle');
  }, []);

  const playFallback = useCallback(async (
    text: string,
    language: 'ru' | 'en',
    generation: number,
  ) => {
    if (generation !== generationRef.current) return;
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      setState('error');
      return;
    }
    const synth = window.speechSynthesis;
    const voice = await waitForFallbackVoice(synth, language);
    if (generation !== generationRef.current) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language === 'ru' ? 'ru-RU' : 'en-US';
    utterance.rate = 0.96;
    utterance.voice = voice;
    utterance.onend = () => {
      if (generation === generationRef.current) setState('idle');
    };
    utterance.onerror = () => {
      if (generation === generationRef.current) setState('error');
    };
    setUsedFallback(true);
    setState('playing');
    synth.speak(utterance);
  }, []);

  const play = useCallback(
    async (text: string, language: 'ru' | 'en') => {
      stop();
      const generation = generationRef.current;
      setUsedFallback(false);
      setState('loading');
      let fallbackStarted = false;
      const startFallback = () => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        void playFallback(text, language, generation);
      };
      try {
        const url = await loaderRef.current!.load(text, language);
        if (generation !== generationRef.current) return;
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        audio.onended = () => {
          if (generation === generationRef.current) setState('idle');
        };
        audio.onerror = startFallback;
        audio.src = url;
        audio.currentTime = 0;
        await audio.play();
        if (generation === generationRef.current) setState('playing');
      } catch {
        startFallback();
      }
    },
    [playFallback, stop],
  );

  const prefetch = useCallback((text: string | undefined, language: 'ru' | 'en') => {
    if (!text?.trim()) return;
    void loaderRef.current!.load(text, language).catch(() => undefined);
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
      loaderRef.current?.clear();
    },
    [],
  );

  return { state, usedFallback, play, stop, prefetch };
}
