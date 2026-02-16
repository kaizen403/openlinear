import React from 'react';
import { useCurrentFrame, interpolate, spring, Easing } from 'remotion';

interface TaglineRevealProps {
  text?: string;
}

export const TaglineReveal: React.FC<TaglineRevealProps> = ({ text = 'AI-Powered Code Execution' }) => {
  const frame = useCurrentFrame();

  // Delay the tagline appearance
  const startFrame = 90; // Start at 3 seconds (90 frames at 30fps)

  const opacity = interpolate(frame, [startFrame, startFrame + 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const translateY = spring({
    frame: frame - startFrame,
    fps: 30,
    config: {
      damping: 20,
      stiffness: 100,
      mass: 0.8,
    },
  });

  const glowIntensity = interpolate(frame, [startFrame + 10, startFrame + 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Letter stagger for word-by-word reveal
  const words = text.split(' ');

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: '180px',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '12px',
          opacity,
          transform: `translateY(${20 - translateY * 20}px)`,
        }}
      >
        {words.map((word, wordIndex) => {
          const wordDelay = wordIndex * 6;
          const wordFrame = frame - startFrame - wordDelay;

          const wordOpacity = interpolate(wordFrame, [0, 15], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          const wordTranslateY = interpolate(wordFrame, [0, 20], [15, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.out(Easing.quad),
          });

          return (
            <span
              key={wordIndex}
              style={{
                fontSize: '32px',
                fontWeight: 400,
                fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
                letterSpacing: '3px',
                color: '#a0a0a0',
                opacity: wordOpacity,
                transform: `translateY(${wordTranslateY}px)`,
                textTransform: 'uppercase',
              }}
            >
              {word}
            </span>
          );
        })}
      </div>

      {/* Subtle accent line */}
      <div
        style={{
          position: 'absolute',
          bottom: 'calc(50% - 120px)',
          left: '50%',
          transform: `translateX(-50%) scaleX(${glowIntensity})`,
          width: 200,
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.5), transparent)',
          opacity: glowIntensity,
        }}
      />
    </div>
  );
};
