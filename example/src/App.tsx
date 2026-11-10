import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

function App() {
	const overview = useQuery(api.demo.overview);
	const addUsers = useMutation(api.demo.addUsers);
	const addRequests = useMutation(api.demo.addRequests);
	const apply = useMutation(api.demo.apply);
	const rebuild = useMutation(api.demo.rebuild);

	return (
		<>
			<h1>convex-improved-migration</h1>
			<p className="lead">
				One Plan of Seeds, Migrations and Rebuilds. Add users in the old shape,
				apply the Plan, and watch each Step run Batch by Batch. Once the role
				Migration is Done, new users get their role when they are added.
			</p>

			<div className="actions">
				<button onClick={() => void addUsers({ count: 250 })}>
					Add 250 users
				</button>
				<button onClick={() => void addRequests({})}>Add requests</button>
				<button disabled={overview?.running} onClick={() => void apply({})}>
					Apply the Plan
				</button>
				<button disabled={overview?.running} onClick={() => void rebuild({})}>
					Rebuild derived data
				</button>
			</div>

			{overview === undefined ? (
				<p className="muted">Loading the Plan.</p>
			) : (
				<>
					<p className="plan-state">
						Plan:{" "}
						<span className={`state ${overview.state}`}>{overview.state}</span>
						{overview.importSuspected &&
							" Snapshot import suspected. The next apply runs every Rebuild again."}
					</p>
					<table>
						<thead>
							<tr>
								<th>Step</th>
								<th>Kind</th>
								<th>State</th>
								<th>Processed</th>
								<th>Skipped</th>
								<th>Note</th>
							</tr>
						</thead>
						<tbody>
							{overview.steps.map((step) => (
								<tr key={step.id}>
									<td>{step.id}</td>
									<td>{step.kind}</td>
									<td>
										<span className={`state ${step.state}`}>{step.state}</span>
									</td>
									<td className="number">{step.processed}</td>
									<td className="number">{step.skipped}</td>
									<td>{step.reason}</td>
								</tr>
							))}
						</tbody>
					</table>

					<h2>Newest users</h2>
					<p className="muted">
						{overview.roleReady
							? "The role Migration is Done here, so readers use the stored role."
							: 'The role Migration is not Done here, so readers fall back to "member".'}
					</p>
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Stored role</th>
								<th>Role shown to readers</th>
							</tr>
						</thead>
						<tbody>
							{overview.users.map((user) => (
								<tr key={user._id}>
									<td>{user.name}</td>
									<td>
										{user.stored ?? <span className="muted">not set</span>}
									</td>
									<td>{user.shown}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</>
	);
}

export default App;
