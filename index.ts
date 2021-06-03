import { Plugin } from '@posthog/plugin-scaffold'

declare var posthog: {
    capture: (eventName: string, properties: Record<string, any>) => void
}

type SessionTrackerPlugin = Plugin<{
    config: {
        sessionLength: string
        sessionStartEvent: string
        sessionEndEvent: string
    }
    global: {
        sessionLength: number
        sessionStartEvent: string
        sessionEndEvent: string
    }
    jobs: {
        checkIfSessionIsOver: { distinct_id: string, session_start: string }
    }
}>

export const setupPlugin: SessionTrackerPlugin['setupPlugin'] = ({ global, config }) => {
    global.sessionLength = (parseInt(config.sessionLength) || 30) * 60 * 1000
    global.sessionStartEvent = config.sessionStartEvent || 'Session start'
    global.sessionEndEvent = config.sessionEndEvent || 'Session end'
}

export const onEvent: SessionTrackerPlugin['onEvent'] = async (event, { cache, global, jobs }) => {
    // skip this for the session start/end events
    if (event.event === global.sessionStartEvent || event.event === global.sessionEndEvent) {
        return
    }
    const timestamp = event.timestamp || event.properties?.timestamp || event.now || event.sent_at || new Date().toISOString()
    // check if we're the first one to increment this key in the last ${global.sessionLength} milliseconds
    const num_evts_in_session = await cache.incr(`session_${event.distinct_id}`)
    if (num_evts_in_session === 1) {
        // if so, dispatch a session start event
        posthog.capture(global.sessionStartEvent, { distinct_id: event.distinct_id, timestamp })
        // and launch a job to check in sessionLength millis if the session is still alive
        await jobs.checkIfSessionIsOver({ distinct_id: event.distinct_id, session_start: timestamp }).runIn(global.sessionLength, 'milliseconds')
    }
    // make the key expire in ${global.sessionLength} min
    await cache.expire(`session_${event.distinct_id}`, global.sessionLength)
    await cache.set(
        `seen_last_${event.distinct_id}`,
        timestamp
    )

    await cache.set(
        `last_event_count_${event.distinct_id}`,
        num_evts_in_session
    )
}

export const jobs: SessionTrackerPlugin['jobs'] = {
    // a background job to check if a session is still in progress
    checkIfSessionIsOver: async ({ distinct_id, session_start }, { jobs, cache, global }) => {
        // check if there's a key that has not expired
        const ping = await cache.get(`session_${distinct_id}`, undefined)
        if (!ping) {
            // if it expired, dispatch the session end event
            const seen_last =
                (await cache.get(`seen_last_${distinct_id}`, undefined)) ||
                new Date(new Date().valueOf() - global.sessionLength).toISOString()
            const seen_last_timestamp = new Date(seen_last as string).valueOf()
            const duration_seconds = (seen_last_timestamp - new Date(session_start).valueOf()) / 1000
            const seconds_since_last = (Date.now() - seen_last_timestamp) / 1000
            const props: Record<string, any> = { distinct_id, timestamp: seen_last, "duration.seconds": duration_seconds, "session.start": session_start, "seen.last": seen_last, "seen.last.elapsed-since.seconds": seconds_since_last}
            const num_evts_in_session = (await cache.get(`last_event_count_${distinct_id}`, undefined))
            if(num_evts_in_session) {
                props["session.events.count"] = num_evts_in_session
            }

            await cache.set(`seen_last_${distinct_id}`, undefined)

            posthog.capture(global.sessionEndEvent, props)
        } else {
            // if the key is still there, check again in a minute
            await jobs.checkIfSessionIsOver({ distinct_id, session_start }).runIn(1, 'minute')
        }
    },
}
