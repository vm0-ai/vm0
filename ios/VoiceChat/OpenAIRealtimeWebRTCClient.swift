import Foundation
import WebRTC

final class OpenAIRealtimeWebRTCClient: NSObject, RealtimeTransport {
    weak var delegate: RealtimeTransportDelegate?

    private let callsURL = URL(
        string: "https://api.openai.com/v1/realtime/calls"
    )!
    private let urlSession: URLSessioning
    private let peerConnectionFactory: RTCPeerConnectionFactory
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?

    init(urlSession: URLSessioning = URLSession.shared) {
        RTCPeerConnectionFactory.initialize()
        self.urlSession = urlSession
        peerConnectionFactory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
        super.init()
    }

    func connect(clientSecret: String) async throws {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: nil
        )
        guard
            let peerConnection = peerConnectionFactory.peerConnection(
                with: configuration,
                constraints: constraints,
                delegate: self
            )
        else {
            throw RealtimeTransportError.invalidServerResponse
        }
        self.peerConnection = peerConnection

        let audioSource = peerConnectionFactory.audioSource(with: constraints)
        let audioTrack = peerConnectionFactory.audioTrack(
            with: audioSource,
            trackId: "zero-audio"
        )
        self.audioTrack = audioTrack
        peerConnection.add(audioTrack, streamIds: ["zero"])

        let dataChannelConfig = RTCDataChannelConfiguration()
        guard
            let dataChannel = peerConnection.dataChannel(
                forLabel: "oai-events",
                configuration: dataChannelConfig
            )
        else {
            throw RealtimeTransportError.invalidServerResponse
        }
        dataChannel.delegate = self
        self.dataChannel = dataChannel

        let offer = try await offer(peerConnection, constraints: constraints)
        try await setLocalDescription(offer, peerConnection: peerConnection)
        guard let localDescription = peerConnection.localDescription else {
            throw RealtimeTransportError.missingLocalDescription
        }

        let answerSDP = try await exchangeSDP(
            localDescription.sdp,
            clientSecret: clientSecret
        )
        let answer = RTCSessionDescription(type: .answer, sdp: answerSDP)
        try await setRemoteDescription(answer, peerConnection: peerConnection)
    }

    func send(jsonString: String) throws {
        guard let dataChannel, dataChannel.readyState == .open else {
            throw RealtimeTransportError.dataChannelNotOpen
        }
        let data = Data(jsonString.utf8)
        dataChannel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    func setMicrophoneMuted(_ muted: Bool) {
        audioTrack?.isEnabled = !muted
    }

    func close() {
        dataChannel?.close()
        dataChannel = nil
        peerConnection?.close()
        peerConnection = nil
        audioTrack = nil
    }

    private func exchangeSDP(
        _ sdp: String,
        clientSecret: String
    ) async throws -> String {
        var request = URLRequest(url: callsURL)
        request.httpMethod = "POST"
        request.httpBody = Data(sdp.utf8)
        request.setValue(
            "Bearer \(clientSecret)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw RealtimeTransportError.invalidServerResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw RealtimeTransportError.sdpExchangeFailed(
                httpResponse.statusCode
            )
        }
        guard let answer = String(data: data, encoding: .utf8) else {
            throw RealtimeTransportError.invalidServerResponse
        }
        return answer
    }

    private func offer(
        _ peerConnection: RTCPeerConnection,
        constraints: RTCMediaConstraints
    ) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peerConnection.offer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let sdp else {
                    continuation.resume(
                        throwing: RealtimeTransportError.missingLocalDescription
                    )
                    return
                }
                continuation.resume(returning: sdp)
            }
        }
    }

    private func setLocalDescription(
        _ description: RTCSessionDescription,
        peerConnection: RTCPeerConnection
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            peerConnection.setLocalDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: ())
            }
        }
    }

    private func setRemoteDescription(
        _ description: RTCSessionDescription,
        peerConnection: RTCPeerConnection
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            peerConnection.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: ())
            }
        }
    }
}

extension OpenAIRealtimeWebRTCClient: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            delegate?.realtimeTransportDidOpen(self)
        case .closed:
            delegate?.realtimeTransportDidClose(self)
        default:
            break
        }
    }

    func dataChannel(
        _ dataChannel: RTCDataChannel,
        didReceiveMessageWith buffer: RTCDataBuffer
    ) {
        guard
            !buffer.isBinary,
            let text = String(data: buffer.data, encoding: .utf8)
        else {
            return
        }
        delegate?.realtimeTransport(self, didReceive: text)
    }
}

extension OpenAIRealtimeWebRTCClient: RTCPeerConnectionDelegate {
    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didChange stateChanged: RTCSignalingState
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didAdd stream: RTCMediaStream
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didRemove stream: RTCMediaStream
    ) {}

    func peerConnectionShouldNegotiate(
        _ peerConnection: RTCPeerConnection
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didChange newState: RTCIceConnectionState
    ) {
        switch newState {
        case .failed, .disconnected, .closed:
            delegate?.realtimeTransportDidClose(self)
        default:
            break
        }
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didChange newState: RTCPeerConnectionState
    ) {
        switch newState {
        case .failed, .disconnected, .closed:
            delegate?.realtimeTransportDidClose(self)
        default:
            break
        }
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didChange newState: RTCIceGatheringState
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didGenerate candidate: RTCIceCandidate
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didRemove candidates: [RTCIceCandidate]
    ) {}

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didOpen dataChannel: RTCDataChannel
    ) {
        dataChannel.delegate = self
        self.dataChannel = dataChannel
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didStartReceivingOn transceiver: RTCRtpTransceiver
    ) {}
}
