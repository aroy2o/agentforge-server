async function test() {
    try {
        const res = await fetch('http://localhost:8000/api/v1/heartbeat');
        console.log('Status:', res.status);
        const data = await res.json();
        console.log('Data:', data);
    } catch (e) {
        console.error('Error:', e.message);
    }
}
test();
