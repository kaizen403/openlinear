"use client"

import { useRef, useState, useEffect, useMemo } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Text3D, Center, useFont } from "@react-three/drei"
import * as THREE from "three"

function Scene() {
  const groupRef = useRef<THREE.Group>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const font = useFont("/fonts/mono-bold.json")
  const { viewport } = useThree()
  const entered = useRef(0)

  const scale = useMemo(() => {
    return Math.min(viewport.width / 10, 1.5)
  }, [viewport.width])

  useFrame((_state, delta) => {
    if (!groupRef.current) return

    entered.current = Math.min(entered.current + delta * 1.2, 1)
    const t = 1 - Math.pow(1 - entered.current, 3)

    groupRef.current.scale.setScalar(scale * t)
    groupRef.current.rotation.x = (1 - t) * -0.3
    groupRef.current.position.y = (1 - t) * -1.5
  })

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 6, 8]} intensity={2} color="#ffffff" />
      <directionalLight position={[-5, 2, -4]} intensity={0.6} color="#2563eb" />

      <group ref={groupRef}>
        <Center>
          <mesh ref={meshRef}>
            <Text3D
              font={font.data}
              size={1.6}
              height={0.6}
              bevelEnabled
              bevelSize={0.01}
              bevelThickness={0.01}
              bevelSegments={2}
              curveSegments={32}
              letterSpacing={-0.06}
            >
              OpenLinear
              <meshStandardMaterial
                color="#3b82f6"
                metalness={0.25}
                roughness={0.2}
              />
            </Text3D>
          </mesh>
        </Center>
      </group>
    </>
  )
}

export function Hero3DTitle() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <div className="w-full h-[140px] md:h-[180px] lg:h-[220px] mb-8 flex items-center">
        <h1 className="text-[48px] md:text-[72px] lg:text-[88px] font-bold tracking-[-3px] md:tracking-[-4px] leading-[1] text-blue-500" style={{ fontFamily: "ui-monospace, monospace" }}>
          OpenLinear
        </h1>
      </div>
    )
  }

  return (
    <div className="w-full h-[140px] md:h-[180px] lg:h-[220px] mb-8">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 35 }}
        dpr={[2, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ background: "transparent" }}
      >
        <Scene />
      </Canvas>
    </div>
  )
}
