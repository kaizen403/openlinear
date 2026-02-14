import React from 'react';
import { useCurrentFrame, interpolate, spring, Easing } from 'remotion';

interface TitleRevealProps {
  text?: string;
}

export const TitleReveal: React.FC<TitleRevealProps> = ({ text = 'KazCode' }) => {
  const frame = useCurrentFrame();

  // Container fade in
  const containerOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Letter animation with staggered delay
  const letters = text.split('');

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: containerOpacity,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
        }}
      >
        {letters.map((letter, index) => {
          const delay = index * 4;
          const letterFrame = frame - delay;

          const opacity = interpolate(letterFrame, [0, 20], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          const scale = spring({
            frame: letterFrame,
            fps: 30,
            config: {
              damping: 15,
              stiffness: 150,
              mass: 0.8,
            },
          });

          const translateY = interpolate(letterFrame, [0, 25], [30, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.out(Easing.cubic),
          });

          const glowIntensity = interpolate(letterFrame, [10, 40], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          return (
            <span
              key={index}
              style={{
                fontSize: '120px',
                fontWeight: 800,
                fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
                letterSpacing: '-2px',
                color: '#ffffff',
                opacity,
                transform: `translateY(${translateY}px) scale(${0.5 + scale * 0.5})`,
                textShadow: `0 0 ${20 + glowIntensity * 30}px rgba(139, 92, 246, ${0.5 + glowIntensity * 0.5}),
                             0 0 ${40 + glowIntensity * 60}px rgba(59, 130, 246, ${0.3 + glowIntensity * 0.4})`,
              }}
            >
              {letter}
            </span>
          );
        })}
      </div>

      {/* Gradient underline */}
      <div
        style={{
          position: 'absolute',
          bottom: 'calc(50% - 80px)',
          left: '50%',
          transform: 'translateX(-50%)',
          width: interpolate(frame, [30, 60], [0, 300], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          height: 3,
          borderRadius: '2px',
          background: 'linear-gradient(90deg, transparent, #8b5cf6, #3b82f6, transparent)',
          boxShadow: '0 0 20px rgba(139, 92, 246, 0.5), 0 0 40px rgba(59, 130, 246, 0.3)',
        }}
      />
    </div>
  );
};
