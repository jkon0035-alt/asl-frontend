import { useState, useEffect, useRef } from 'react'
import * as tf from '@tensorflow/tfjs'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { io } from 'socket.io-client'
import './App.css'

function App() {
  const videoRef = useRef(null)
  const modelRef = useRef(null)
  const labelsRef = useRef(null)
  const landmarkerRef = useRef(null)
  const canvasRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const socketRef = useRef(null)
  const letterBufferRef = useRef([])
  const letterTimerRef = useRef(null)
  const lastLetterRef = useRef('')

  const [predictedLetter, setPredictedLetter] = useState('')
  const [remoteLetter, setRemoteLetter] = useState('')
  const [sentence, setSentence] = useState('')
  const [roomId] = useState('test-room')
  const [cameraReady, setCameraReady] = useState(false)
  const [darkMode, setDarkMode] = useState(true)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [timerWidth, setTimerWidth] = useState(0)

  useEffect(() => {
    async function startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
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
          const confidence = Math.max(...Array.from(prediction.dataSync()))
          const letter = labelsRef.current[index]

          if (confidence > 0.92) {
            letterBufferRef.current.push(letter)
            if (letterBufferRef.current.length > 5) {
              letterBufferRef.current.shift()
            }
            const mostCommon = letterBufferRef.current
              .sort((a, b) =>
                letterBufferRef.current.filter(v => v === a).length -
                letterBufferRef.current.filter(v => v === b).length
              ).pop()

            setPredictedLetter(mostCommon)

            if (socketRef.current) {
              socketRef.current.emit('word-detected', { roomId, word: mostCommon })
            }

            // Timer based sentence builder
            if (mostCommon !== lastLetterRef.current) {
              lastLetterRef.current = mostCommon
              if (letterTimerRef.current) clearTimeout(letterTimerRef.current)
              setTimerWidth(0)
              setTimeout(() => setTimerWidth(100), 50)
              letterTimerRef.current = setTimeout(() => {
                setSentence(prev => prev + mostCommon)
                setTimerWidth(0)
              }, 1000)
            }
          }

          tensor.dispose()
          prediction.dispose()
        }
        else {
    setPredictedLetter('')
    lastLetterRef.current = ''
    letterBufferRef.current = []
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
      setRemoteLetter(data.word)
    })

  }, [roomId, cameraReady])

  function toggleMute() {
    const stream = videoRef.current?.srcObject
    if (stream) {
      stream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled
      })
      setMuted(prev => !prev)
    }
  }

  function toggleCamera() {
    const stream = videoRef.current?.srcObject
    if (stream) {
      stream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled
      })
      setCameraOff(prev => !prev)
    }
  }

  function endCall() {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
    }
    if (socketRef.current) {
      socketRef.current.disconnect()
    }
    const stream = videoRef.current?.srcObject
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
    }
    window.location.reload()
  }

  function clearSentence() {
    setSentence('')
  }

  return (
    <div className={`app ${darkMode ? 'dark' : 'light'}`}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Header */}
      <div className="header">
        <h1>✋ ASL Detector</h1>
        <button className="theme-toggle" onClick={() => setDarkMode(prev => !prev)}>
          {darkMode ? '☀️' : '🌙'}
        </button>
      </div>

      {/* Videos */}
      <div className="video-section">
        <div className="video-card">
          <div className="video-wrapper">
            <video ref={videoRef} autoPlay muted />
            <span className="video-label">You</span>
            <div
              className="timer-bar"
              style={{ width: `${timerWidth}%` }}
            />
          </div>
          <div className="letter-display">{predictedLetter}</div>
        </div>

        <div className="video-card">
          <div className="video-wrapper">
            <video ref={remoteVideoRef} autoPlay />
            <span className="video-label">Remote</span>
          </div>
          <div className="letter-display">{remoteLetter}</div>
        </div>
      </div>

      {/* Sentence Panel */}
      <div className="sentence-panel">
        <p>Sentence</p>
        <div className="sentence-text">{sentence || '...'}</div>
        {sentence && (
          <button
            onClick={clearSentence}
            style={{
              marginTop: '8px',
              background: 'none',
              border: 'none',
              opacity: 0.5,
              cursor: 'pointer',
              fontSize: '0.75rem',
              color: 'inherit'
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Control Bar */}
      <div className="control-bar">
        <button
          className={`ctrl-btn ${muted ? 'active' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🎙️'}
        </button>
        <button
          className={`ctrl-btn ${cameraOff ? 'active' : ''}`}
          onClick={toggleCamera}
          title={cameraOff ? 'Turn camera on' : 'Turn camera off'}
        >
          {cameraOff ? '📷' : '🎥'}
        </button>
        <button
          className="ctrl-btn end"
          onClick={endCall}
          title="End call"
        >
          📵
        </button>
      </div>
    </div>
  )
}

export default App
