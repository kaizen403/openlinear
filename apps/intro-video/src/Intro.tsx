import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { GlowReveal } from './scenes/GlowReveal';
import { TitleReveal } from './scenes/TitleReveal';
import { TaglineReveal } from './scenes/TaglineReveal';
import { FadeOut } from './scenes/FadeOut';
import { Particles } from './components/Particles';

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: '#0a0a0a',
        overflow: 'hidden',
      }}
    >
      <GlowReveal />
      <Particles />
      <TitleReveal />
      <TaglineReveal />
      <FadeOut />
    </div>
  );
};
