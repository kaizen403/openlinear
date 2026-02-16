import React from 'react';
import { useCurrentFrame, interpolate, spring } from 'remotion';

export const GlowReveal: React.FC = () => {
  const frame = useCurrentFrame();

  const glowIntensity = interpolate(frame, [0, 60], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const scale = spring({
    frame,
    fps: 30,
    config: {
      damping: 100,
      stiffness: 50,
      mass: 1,
    },
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(ellipse at center, #1a1a2e 0%, #0a0a0a 70%)',
      }}
    >
      {/* Central glow orb */}
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.3) 0%, rgba(59, 130, 246, 0.1) 40%, transparent 70%)',
          transform: `scale(${0.5 + scale * 0.5})`,
          opacity: glowIntensity * 0.8,
          filter: 'blur(40px)',
        }}
      />
      
      {/* Secondary glow */}
      <div
        style={{
          position: 'absolute',
          width: 400,
          height: 400,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, transparent 60%)',
          transform: `scale(${0.3 + scale * 0.7})`,
          opacity: glowIntensity * 0.6,
          filter: 'blur(30px)',
        }}
      />

      {/* Grid overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(139, 92, 246, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(139, 92, 246, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          opacity: glowIntensity * 0.5,
        }}
      />
    </div>
  );
};
