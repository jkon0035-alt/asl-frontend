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
  const sentenceRef = useRef('')

  const [predictedLetter, setPredictedLetter] = useState('')
  const [remoteLetter, setRemoteLetter] = useState('')
  const [sentence, setSentence] = useState('')
  const [remoteSentence, setRemoteSentence] = useState('')
  const [roomId] = useState('test-room')
  const [cameraReady, setCameraReady] = useState(false)
  const [darkMode, setDarkMode] = useState(true)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [timerWidth, setTimerWidth] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [callEnded, setCallEnded] = useState(false)
  const [remoteConnected, setRemoteConnected] = useState(false)

  useEffect(() => {
    async function startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      })
      videoRef.current.srcObject = stream

      modelRef.current = await tf.loadGraphModel('/asl_model_web/model.json')
      const response = await fetch('/labels.json')
      labelsRef.current = await response.json()

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
            const mostCommon = letterBufferRef.current.sort((a, b) =>
                letterBufferRef.current.filter(v => v === a).length -
                letterBufferRef.current.filter(v => v === b).length
              ).pop()
            const filtered = ['space', 'nothing', 'del']
            if (!filtered.includes(mostCommon)) {
                setPredictedLetter(mostCommon)
                // rest of your timer code
            }
            setPredictedLetter(mostCommon)

            if (mostCommon !== lastLetterRef.current) {
              lastLetterRef.current = mostCommon
              if (letterTimerRef.current) clearTimeout(letterTimerRef.current)
              setTimerWidth(0)
              setTimeout(() => setTimerWidth(100), 50)
              letterTimerRef.current = setTimeout(() => {
                sentenceRef.current = sentenceRef.current + mostCommon
                setSentence(sentenceRef.current)
                if (socketRef.current) {
                  socketRef.current.emit('word-detected', {
                    roomId,
                    word: mostCommon,
                    sentence: sentenceRef.current
                  })
                }
                setTimerWidth(0)
              }, 1000)
            }
          }

          tensor.dispose()
          prediction.dispose()
        } else {
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
      socket.emit('join-room', roomId)
    })

    socket.on('user-joined', async (userId) => {
      setRemoteConnected(true)
      const pc = new RTCPeerConnection(config)
      peerConnectionRef.current = pc

      const stream = videoRef.current?.srcObject
      if (stream) {
        stream.getTracks().forEach(track => pc.addTrack(track, stream))
      }

      pc.ontrack = (event) => {
      console.log("Received remote stream", event.streams)

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0]
        remoteVideoRef.current.play().catch(console.error)
        }
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
      setRemoteConnected(true)
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
      if (data.sentence) setRemoteSentence(data.sentence)
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
    setCallEnded(true)
  }

  if (callEnded) {
    return (
      <div className={`app ${darkMode ? 'dark' : 'light'}`}>
        <div className="call-ended">
          <span style={{ fontSize: '2.5rem' }}>📵</span>
          <h2>Call Ended</h2>
          <p>Your session has ended</p>
          <button className="rejoin-btn" onClick={() => window.location.reload()}>
            Rejoin
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`app ${darkMode ? 'dark' : 'light'}`}>
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>How to use ASL Detector</h2>
              <button className="modal-close" onClick={() => setShowHelp(false)}>✕</button>
            </div>

            <div className="help-section">
              <h3>Getting Started</h3>
              <div className="help-steps">
                <div className="help-step">
                  <span className="step-num">1</span>
                  <span>Allow camera access when prompted by your browser</span>
                </div>
                <div className="help-step">
                  <span className="step-num">2</span>
                  <span>Share the URL with someone else — they open the same link to join your call</span>
                </div>
                <div className="help-step">
                  <span className="step-num">3</span>
                  <span>Hold your hand in front of the camera and sign ASL letters</span>
                </div>
                <div className="help-step">
                  <span className="step-num">4</span>
                  <span>Hold each letter steady for 1 second — it will be added to the sentence automatically</span>
                </div>
                <div className="help-step">
                  <span className="step-num">5</span>
                  <span>Your sentence appears below the videos and is sent to the other person in real time</span>
                </div>
              </div>
            </div>

            <div className="help-section">
              <h3>Tips for better detection</h3>
              <div className="help-steps">
                <div className="help-step">
                  <span className="step-num">💡</span>
                  <span>Good lighting on your hand improves accuracy significantly</span>
                </div>
                <div className="help-step">
                  <span className="step-num">💡</span>
                  <span>Keep your hand centred in the camera frame</span>
                </div>
                <div className="help-step">
                  <span className="step-num">💡</span>
                  <span>Letters like M, N, S are similar — hold them extra steady</span>
                </div>
              </div>
            </div>

            <div className="help-section">
              <h3>Supported letters</h3>
              <div className="asl-grid">
                {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => (
                  <div key={l} className="asl-letter">{l}</div>
                ))}
                <div className="asl-letter">DEL</div>
                <div className="asl-letter">SPC</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="header">
        <div className="header-left">
          <h1>✋ ASL Detector</h1>
        </div>
        <div className="header-right">
          <button className="icon-btn" onClick={() => setShowHelp(true)} title="Help">?</button>
          <button className="icon-btn" onClick={() => setDarkMode(prev => !prev)} title="Toggle theme">
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>
      </div>

      <div className="main">
        <div className="video-grid">
          <div className="video-card">
            <video ref={videoRef} autoPlay muted />
            <div className="video-overlay">
              <span className="video-name">You</span>
              <span className="video-letter">{predictedLetter}</span>
            </div>
            <div className="timer-bar" style={{ width: `${timerWidth}%` }} />
          </div>

          <div className="video-card">
            {remoteConnected
              ? <video ref={remoteVideoRef} autoPlay playsInline />
              : (
                <div className="no-video">
                  <video ref={remoteVideoRef} autoPlay style={{ display: 'none' }} />
                  Waiting for someone to join...
                </div>
              )
            }
            <div className="video-overlay">
              <span className="video-name">Remote</span>
              <span className="video-letter">{remoteLetter}</span>
            </div>
          </div>
        </div>

        <div className="sentence-panel">
          <span className="sentence-label">You</span>
          <span className={`sentence-text ${!sentence ? 'sentence-muted' : ''}`}>
            {sentence || 'Start signing to build a sentence...'}
          </span>
          {sentence && (
            <button className="clear-btn" onClick={() => {
              setSentence('')
              sentenceRef.current = ''
            }}>
              Clear
            </button>
          )}
        </div>

        <div className="remote-sentence-panel">
          <span className="sentence-label">Remote</span>
          <span className="remote-sentence-text">
            {remoteSentence || 'Waiting for remote signing...'}
          </span>
        </div>
      </div>

      <div className="control-bar">
        <button
          className={`ctrl-btn ${muted ? 'off' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🎙️'}
        </button>
        <button
          className={`ctrl-btn ${cameraOff ? 'off' : ''}`}
          onClick={toggleCamera}
          title={cameraOff ? 'Camera on' : 'Camera off'}
        >
          {cameraOff ? '📷' : '🎥'}
        </button>
        <button className="ctrl-btn end" onClick={endCall} title="End call">
          📵
        </button>
      </div>
    </div>
  )
}

export default App
