import React, { useMemo } from 'react';
import { useCurrentFrame, interpolate, spring, random } from 'remotion';

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

export const Particles: React.FC = () => {
  const frame = useCurrentFrame();

  const particles = useMemo<Particle[]>(() => {
    const count = 30;
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      x: random(`particle-x-${i}`) * 1920,
      y: random(`particle-y-${i}`) * 1080,
      size: random(`particle-size-${i}`) * 3 + 1,
      delay: random(`particle-delay-${i}`) * 60,
      duration: random(`particle-duration-${i}`) * 120 + 60,
    }));
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {particles.map((particle) => {
        const opacity = interpolate(
          frame,
          [particle.delay, particle.delay + 30, particle.delay + particle.duration - 30, particle.delay + particle.duration],
          [0, 0.6, 0.6, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );

        const floatY = spring({
          frame: frame - particle.delay,
          fps: 30,
          config: {
            damping: 200,
            stiffness: 50,
            mass: 2,
          },
        });

        const yOffset = floatY * 20;

        return (
          <div
            key={particle.id}
            style={{
              position: 'absolute',
              left: particle.x,
              top: particle.y + yOffset,
              width: particle.size,
              height: particle.size,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(139, 92, 246, 0.8) 0%, rgba(59, 130, 246, 0.4) 50%, transparent 70%)',
              boxShadow: `0 0 ${particle.size * 4}px rgba(139, 92, 246, 0.5)`,
              opacity,
              transform: `scale(${1 + floatY * 0.2})`,
            }}
          />
        );
      })}
    </div>
  );
};
