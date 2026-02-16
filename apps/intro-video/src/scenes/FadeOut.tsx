import React from 'react';
import { useCurrentFrame, interpolate, Easing } from 'remotion';

export const FadeOut: React.FC = () => {
  const frame = useCurrentFrame();

  // Start fade out at 8 seconds (240 frames)
  const fadeStartFrame = 240;

  const overlayOpacity = interpolate(frame, [fadeStartFrame, fadeStartFrame + 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.quad),
  });

  const scale = interpolate(frame, [fadeStartFrame, fadeStartFrame + 60], [1, 1.1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0a0a0a',
        opacity: overlayOpacity,
        transform: `scale(${scale})`,
        pointerEvents: 'none',
      }}
    >
      {/* Final glow that fades in */}
      <div
        style={{
          position: 'absolute',
          width: 800,
          height: 800,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.2) 0%, transparent 60%)',
          opacity: interpolate(frame, [fadeStartFrame, fadeStartFrame + 30], [0, 0.5], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          filter: 'blur(60px)',
        }}
      />
    </div>
  );
};
