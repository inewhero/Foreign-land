import { AdminApp } from "./AdminApp";
import { ParticipantApp } from "./ParticipantApp";

export default function App() {
  return location.pathname.startsWith("/admin") ? <AdminApp /> : <ParticipantApp />;
}
