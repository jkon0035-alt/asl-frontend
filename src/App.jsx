import { useState, useEffect, useRef } from 'react'
import * as tf from '@tensorflow/tfjs'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { io } from 'socket.io-client'

function App() {
  const videoRef = useRef(null)
  const modelRef = useRef(null)
  const labelsRef = useRef(null)
  const landmarkerRef = useRef(null)
  const [predictedLetter, setPredictedLetter] = useState('')
  const canvasRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const socketRef = useRef(null)
  const [roomId, setRoomId] = useState('test-room')
  const [cameraReady, setCameraReady] = useState(false)
  useEffect(() => {
    async function startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      
      videoRef.current.srcObject = stream

      modelRef.current = await tf.loadGraphModel('/asl_model_web/model.json')
      const response = await fetch('/labels.json')
      labelsRef.current = await response.json()
      console.log('Model loaded', labelsRef.current)
      
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      )
      landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task'
    },
    runningMode: 'VIDEO',
    numHands: 2
})
  
      console.log('MediaPipe loaded')
      function detect() {
    if (!videoRef.current || !landmarkerRef.current) return
    
    const results = landmarkerRef.current.detectForVideo(
        videoRef.current, 
        performance.now()
    )
    
    if (results.landmarks && results.landmarks.length > 0) {
        const hand = results.landmarks[0]
        const row = []
        for (const landmark of hand) {
            row.push(landmark.x)
            row.push(landmark.y)
            row.push(landmark.z)
        }
        const tensor = tf.tensor2d([row])
        const prediction = modelRef.current.predict(tensor)
        const index = prediction.argMax(1).dataSync()[0]
        const letter = labelsRef.current[index]
        setPredictedLetter(letter)
        tensor.dispose()
        prediction.dispose()
    }
    requestAnimationFrame(detect)
}
detect()
setCameraReady(true)
    }
    startCamera()
  }, [])

useEffect(() => {
  if (!cameraReady) return
  const socket = io('https://asl-backend-production-6c18.up.railway.app')
  socketRef.current = socket

  const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  }

  socket.on('connect', () => {
    console.log('Connected to signalling server')
    socket.emit('join-room', roomId)
  })

  socket.on('user-joined', async (userId) => {
    console.log('User joined:', userId)
    const pc = new RTCPeerConnection(config)
    peerConnectionRef.current = pc

    const stream = videoRef.current?.srcObject
    if (stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream))
    }

    pc.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0]
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { roomId, candidate: event.candidate })
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    socket.emit('offer', { roomId, offer })
    })

  socket.on('offer', async (data) => {
    const pc = new RTCPeerConnection(config)
    peerConnectionRef.current = pc

    const stream = videoRef.current?.srcObject
    if (stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream))
    }

    pc.ontrack = (event) => {
      remoteVideoRef.current.srcObject = event.streams[0]
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { roomId, candidate: event.candidate })
      }
    }

    await pc.setRemoteDescription(data.offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    socket.emit('answer', { roomId, answer })
    })

  socket.on('answer', async (data) => {
    if (peerConnectionRef.current && 
        peerConnectionRef.current.signalingState !== 'stable') {
        await peerConnectionRef.current.setRemoteDescription(data.answer)
    }
    })

  socket.on('ice-candidate', async (data) => {
    if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(data.candidate)
    }
    })

  socket.on('word-detected', (data) => {
    console.log('Remote word:', data.word)
    })

}, [roomId, cameraReady])
  return (
    <div>
      <h1>ASL Detector</h1>
      <video ref={videoRef} autoPlay />
      <h2>{predictedLetter}</h2>
      <video ref={remoteVideoRef} autoPlay />
    </div>
  )
}

export default App