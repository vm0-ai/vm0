#if canImport(CoreMedia)
import AVFoundation
import CoreMedia
import Foundation

/// Changes media timing and selects captured audio frames without changing
/// their values. A timing entry describes one sample, not the whole buffer.
public enum MediaSampleTiming {
    public static func retimed(
        _ sample: CMSampleBuffer, to presentationTime: CMTime, videoDuration: CMTime? = nil
    ) -> CMSampleBuffer? {
        var count = 0
        guard CMSampleBufferGetSampleTimingInfoArray(
            sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count
        ) == noErr, count > 0 else { return nil }
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(
            sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: nil
        ) == noErr else { return nil }
        let offset = CMTimeSubtract(presentationTime, CMSampleBufferGetPresentationTimeStamp(sample))
        for index in timing.indices {
            timing[index].presentationTimeStamp = CMTimeAdd(timing[index].presentationTimeStamp, offset)
            if timing[index].decodeTimeStamp.isValid {
                timing[index].decodeTimeStamp = CMTimeAdd(timing[index].decodeTimeStamp, offset)
            }
        }
        if let videoDuration {
            guard CMSampleBufferGetNumSamples(sample) == 1, count == 1 else { return nil }
            timing[0].duration = videoDuration
        }
        var copy: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault, sampleBuffer: sample,
            sampleTimingEntryCount: count, sampleTimingArray: &timing, sampleBufferOut: &copy
        )
        return status == noErr ? copy : nil
    }

    /// Keeps complete audio frames between the video anchor and stop, outside
    /// pause spans. A boundary can remove at most one fractional audio frame.
    public static func audioSegments(
        _ sample: CMSampleBuffer, anchor: CMTime, pauses: PauseTimeline, captureEnd: Double?
    ) -> [CMSampleBuffer]? {
        let start = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sample), anchor).seconds
        let duration = CMSampleBufferGetDuration(sample).seconds
        let count = CMSampleBufferGetNumSamples(sample)
        guard start.isFinite, duration.isFinite, duration > 0, count > 0 else { return nil }
        let lower = max(0, start)
        let upper = min(start + duration, captureEnd ?? (start + duration))
        guard lower < upper else { return [] }
        let rate = Double(count) / duration
        var result: [CMSampleBuffer] = []
        for range in pauses.recordedRanges(in: lower..<upper) {
            let first = max(0, min(count, Int(ceil((range.lowerBound - start) * rate - 0.000_001))))
            let end = max(first, min(count, Int(floor((range.upperBound - start) * rate + 0.000_001))))
            guard first < end else { continue }
            if first == 0, end == count {
                result.append(sample)
                continue
            }
            guard let copy = copyAudioFrames(sample, first: first, count: end - first) else { return nil }
            result.append(copy)
        }
        return result
    }

    private static func copyAudioFrames(
        _ sample: CMSampleBuffer, first: Int, count: Int
    ) -> CMSampleBuffer? {
        // CopySampleBufferForRange explicitly does not support non-interleaved
        // audio, which is the format ScreenCaptureKit delivers for stereo.
        guard let description = CMSampleBufferGetFormatDescription(sample),
            let pcm = AVAudioPCMBuffer(
                pcmFormat: AVAudioFormat(cmAudioFormatDescription: description),
                frameCapacity: AVAudioFrameCount(count)
            )
        else { return nil }
        pcm.frameLength = AVAudioFrameCount(count)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: Int32(first), frameCount: Int32(count), into: pcm.mutableAudioBufferList
        ) == noErr else { return nil }
        var timing = CMSampleTimingInfo()
        guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr else { return nil }
        timing.presentationTimeStamp = CMTimeAdd(
            timing.presentationTimeStamp, CMTimeMultiply(timing.duration, multiplier: Int32(first))
        )
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: description,
            sampleCount: count, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &copy
        ) == noErr, let copy else { return nil }
        guard CMSampleBufferSetDataBufferFromAudioBufferList(
            copy, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList
        ) == noErr, CMSampleBufferSetDataReady(copy) == noErr else { return nil }
        return copy
    }
}
#endif
